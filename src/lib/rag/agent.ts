import Anthropic from "@anthropic-ai/sdk";
import { logError } from "../error-logger";
import {
  TOOL_DEFINITIONS,
  executeTool,
  CaseRegistry,
  type ToolCallRecord,
  type ToolContext,
  type ToolName,
} from "./agentTools";
import { AGENT_SYSTEM_PROMPT } from "./agentPrompt";
import type { SessionDocumentStore } from "./sessionStore";
import type { AssembledCase } from "./contextBuilder";
import type { PipelineStepRecord } from "./pipeline";
import type { ChatMessage, SearchFilters, CitedCase } from "@/types";

/**
 * Agentic retrieval loop.
 *
 * Replaces the old router → retrieve → rerank → generate pipeline. The model
 * decides at generation time which tools to call (list_session_cases,
 * load_case, search_fresh, lookup_by_citation) and composes its own context.
 *
 * Streaming contract: runAgent takes `onTextDelta` + `onToolEvent` callbacks
 * so the SSE route handler can forward events to the client as they arrive.
 * The returned promise resolves with the final trace + usage + cited cases.
 */

const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "claude-sonnet-4-6";
const MAX_AGENT_STEPS = 6;
const MAX_TOKENS_PER_STEP = 4096;
const HISTORY_TURNS = 10;

export interface AgentToolEvent {
  type: "start" | "end";
  step_index: number;
  record: ToolCallRecord;
}

export interface AgentRunOptions {
  userMessage: string;
  history: ChatMessage[];
  sessionStore: SessionDocumentStore;
  sessionFilters: SearchFilters;
  /** Fires for every text delta from the model (narrative + final answer). */
  onTextDelta: (delta: string) => void;
  /** Fires when a tool call starts (`type: "start"`, record.status='success' placeholder)
   *  and when it completes. */
  onToolEvent: (event: AgentToolEvent) => void;
  /** Fires once the first tool's cases are registered so the UI can render
   *  the Cases panel before the answer finishes streaming. */
  onCasesUpdate: (cases: CitedCase[]) => void;
}

export interface AgentRunResult {
  assistantContent: string;
  assembledCases: AssembledCase[];
  citedCases: CitedCase[];
  toolTrace: ToolCallRecord[];
  tokens: { input: number; output: number };
  model: string;
  stopReason: string | null;
  stepsUsed: number;
  /** Rendered view of the full system + user + tool messages, for audit only. */
  contextDebug: string;
}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey });
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const client = getClient();
  const registry = new CaseRegistry();
  const toolTrace: ToolCallRecord[] = [];
  const ctx: ToolContext = {
    sessionStore: opts.sessionStore,
    sessionFilters: opts.sessionFilters,
    registry,
    trace: toolTrace,
  };

  // Seed session-case summary into the user-visible turn so the model has
  // zero-cost context about what's already loaded. It can still call
  // list_session_cases for the full detail + cold-tier headnotes.
  const sessionSummary = renderSessionSummary(opts.sessionStore);

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.slice(-HISTORY_TURNS).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: "user",
      content: sessionSummary
        ? `${sessionSummary}\n\nUSER'S CURRENT QUESTION:\n${opts.userMessage}`
        : opts.userMessage,
    },
  ];

  let assistantContent = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let model = CHAT_MODEL;
  let stopReason: string | null = null;
  let stepsUsed = 0;
  let lastCasesCount = 0;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    stepsUsed = step + 1;
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS_PER_STEP,
      system: AGENT_SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    stream.on("text", (delta: string) => {
      assistantContent += delta;
      opts.onTextDelta(delta);
    });

    stream.on("error", (err: unknown) => {
      logError({
        category: "fetching",
        message: err instanceof Error ? err.message : String(err),
        error: err,
        severity: "critical",
        metadata: { step, model: CHAT_MODEL },
      });
    });

    const finalMsg = await stream.finalMessage();
    totalInputTokens += finalMsg.usage.input_tokens;
    totalOutputTokens += finalMsg.usage.output_tokens;
    model = finalMsg.model;
    stopReason = finalMsg.stop_reason ?? null;

    if (finalMsg.stop_reason !== "tool_use") {
      // end_turn, max_tokens, stop_sequence — we're done (success or truncated).
      break;
    }

    const toolUseBlocks = finalMsg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolUseBlocks.length === 0) break;

    // Execute tools in parallel. Each executeTool call appends to toolTrace.
    const toolResultBlocks = await Promise.all(
      toolUseBlocks.map(async (tu) => {
        const startRecord: ToolCallRecord = {
          tool: tu.name as ToolName,
          input: tu.input as Record<string, unknown>,
          started_at: new Date().toISOString(),
          duration_ms: 0,
          status: "success",
          error: null,
          data: {},
          result_preview: "",
        };
        opts.onToolEvent({ type: "start", step_index: step, record: startRecord });
        const resultText = await executeTool(
          tu.name,
          tu.input as Record<string, unknown>,
          ctx
        );
        // The executeTool call pushed the real record onto ctx.trace; retrieve it.
        const finalRecord = toolTrace[toolTrace.length - 1];
        opts.onToolEvent({ type: "end", step_index: step, record: finalRecord });
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: resultText,
        };
      })
    );

    // Push cases update if registry grew.
    if (registry.list().length !== lastCasesCount) {
      lastCasesCount = registry.list().length;
      opts.onCasesUpdate(registry.toCitedCases());
    }

    // Extend the conversation with the assistant's tool_use message and the
    // matching tool_result block(s), then loop for the next step.
    messages.push({ role: "assistant", content: finalMsg.content });
    messages.push({ role: "user", content: toolResultBlocks });
  }

  return {
    assistantContent,
    assembledCases: registry.list(),
    citedCases: registry.toCitedCases(),
    toolTrace,
    tokens: { input: totalInputTokens, output: totalOutputTokens },
    model,
    stopReason,
    stepsUsed,
    contextDebug: JSON.stringify(
      { session_cases_count: opts.sessionStore.caseSummaries.length, history_turns: messages.length },
      null,
      2
    ),
  };
}

/**
 * Adapter: convert the agent's tool-call trace into PipelineStepRecord rows
 * for rag_pipeline_steps. Shape:
 *   step_order 1       = agent_start (what the agent saw as it began)
 *   step_order 2..N+1  = tool_call   (one per tool invocation, in order)
 *   step_order N+2     = generate    (final model output + token usage)
 */
export function buildAgentAuditSteps(params: {
  userMessage: string;
  sessionStore: SessionDocumentStore;
  toolTrace: ToolCallRecord[];
  generate: {
    status: "success" | "error";
    duration_ms: number;
    started_at: string;
    error: string | null;
    data: Record<string, unknown>;
  };
  agentStartedAt: string;
}): PipelineStepRecord[] {
  const { userMessage, sessionStore, toolTrace, generate, agentStartedAt } = params;
  const steps: PipelineStepRecord[] = [];

  steps.push({
    step_order: 1,
    step: "agent_start",
    status: "success",
    duration_ms: 0,
    started_at: agentStartedAt,
    error: null,
    data: {
      user_message_length: userMessage.length,
      session_cases_count: sessionStore.caseSummaries.length,
      hot_cases_count: sessionStore.trace.hot_cases_loaded,
      cold_cases_count: sessionStore.trace.cold_cases,
      hot_chunks_loaded: sessionStore.trace.hot_chunks_loaded,
    },
  });

  for (let i = 0; i < toolTrace.length; i++) {
    const t = toolTrace[i];
    steps.push({
      step_order: i + 2,
      step: "tool_call",
      status: t.status,
      duration_ms: t.duration_ms,
      started_at: t.started_at,
      error: t.error,
      data: {
        tool: t.tool,
        input: t.input,
        result_preview: t.result_preview,
        ...t.data,
      },
    });
  }

  steps.push({
    step_order: toolTrace.length + 2,
    step: "generate",
    status: generate.status,
    duration_ms: generate.duration_ms,
    started_at: generate.started_at,
    error: generate.error,
    data: generate.data,
  });

  return steps;
}

function renderSessionSummary(store: SessionDocumentStore): string {
  if (store.caseSummaries.length === 0) return "";
  const lines: string[] = [
    "SESSION CASES (already cited earlier in this chat — call list_session_cases for full detail, or load_case to fetch text):",
  ];
  for (const s of store.caseSummaries) {
    const cite = s.citation ? ` — ${s.citation}` : "";
    lines.push(
      `  [${s.recency_rank}, ${s.tier}] ${s.title}${cite} (${s.source_table}:${s.source_id})`
    );
  }
  return lines.join("\n");
}
