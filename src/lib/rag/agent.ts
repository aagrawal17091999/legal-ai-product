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
import { cachedSystem, applyCacheBreakpoints } from "./promptCache";
import { decomposeQuestion } from "./decompose";
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
// Budget for tool-calling rounds. Legal synthesis often loads many cases, so
// this must be comfortably above the worst-case "one load per case" count.
// Parallel tool calls (handled below) usually keep the real count far lower.
const MAX_AGENT_STEPS = 10;
const MAX_TOKENS_PER_STEP = 4096;
const HISTORY_TURNS = 10;
// Below this length a question is treated as a short follow-up and skips the
// decomposition Haiku call (#2). Balanced: avoid per-turn cost on simple asks.
const DECOMPOSE_MIN_CHARS = 80;

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
  tokens: {
    input: number;
    output: number;
    /** Tokens served from the prompt cache (~0.1x cost). >0 proves caching hit. */
    cacheRead: number;
    /** Tokens written to the prompt cache this turn (~1.25x cost). */
    cacheWrite: number;
  };
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

  // #2 Decompose compound questions into sub-issues so the agent retrieves for
  // each. Gated on length to avoid the extra Haiku call on short follow-ups;
  // the decomposer itself returns not-compound for single-issue questions.
  let researchPlan = "";
  if (opts.userMessage.trim().length >= DECOMPOSE_MIN_CHARS) {
    const decomposition = await decomposeQuestion(opts.userMessage);
    if (decomposition.isCompound) {
      researchPlan =
        "RESEARCH PLAN — the question bundles distinct sub-issues. Make sure your retrieval and answer cover EACH of these before synthesising:\n" +
        decomposition.subQuestions.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
        "\n\n";
    }
  }

  const userTurn = [researchPlan, sessionSummary ? `${sessionSummary}\n\n` : "",
    sessionSummary || researchPlan ? `USER'S CURRENT QUESTION:\n${opts.userMessage}` : opts.userMessage,
  ].join("");

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.slice(-HISTORY_TURNS).map((m) => ({
      role: m.role,
      content: m.content,
    })),
    {
      role: "user",
      content: userTurn,
    },
  ];

  let assistantContent = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let model = CHAT_MODEL;
  const cachedSystemPrompt = cachedSystem(AGENT_SYSTEM_PROMPT);
  let stopReason: string | null = null;
  let stepsUsed = 0;
  let lastCasesCount = 0;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    stepsUsed = step + 1;
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS_PER_STEP,
      system: cachedSystemPrompt,
      tools: TOOL_DEFINITIONS,
      messages: applyCacheBreakpoints(messages),
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
    totalCacheRead += finalMsg.usage.cache_read_input_tokens ?? 0;
    totalCacheWrite += finalMsg.usage.cache_creation_input_tokens ?? 0;
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

  // Forced final synthesis. If the loop exited while still in `tool_use` (i.e.
  // the agent exhausted MAX_AGENT_STEPS on retrieval and never wrote an answer),
  // make one more call with tools DISABLED so the model is compelled to answer
  // from the context it already gathered. Without this, content is empty and the
  // route emits the "did not produce a response" fallback even though we have
  // loaded cases ready to cite.
  if (stopReason === "tool_use" && assistantContent.trim() === "") {
    logError({
      category: "fetching",
      message: "agent exhausted step budget without text; forcing final synthesis",
      severity: "warning",
      metadata: { steps: stepsUsed, cases_loaded: registry.list().length },
    });

    messages.push({
      role: "user",
      content:
        "You have gathered enough context. Provide your final answer now using ONLY the cases already loaded above. Do not call any more tools.",
    });

    const finalStream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS_PER_STEP,
      system: cachedSystemPrompt,
      tool_choice: { type: "none" },
      tools: TOOL_DEFINITIONS,
      messages: applyCacheBreakpoints(messages),
    });
    finalStream.on("text", (delta: string) => {
      assistantContent += delta;
      opts.onTextDelta(delta);
    });
    finalStream.on("error", (err: unknown) => {
      logError({
        category: "fetching",
        message: err instanceof Error ? err.message : String(err),
        error: err,
        severity: "critical",
        metadata: { phase: "forced_synthesis", model: CHAT_MODEL },
      });
    });
    const finalMsg = await finalStream.finalMessage();
    totalInputTokens += finalMsg.usage.input_tokens;
    totalOutputTokens += finalMsg.usage.output_tokens;
    totalCacheRead += finalMsg.usage.cache_read_input_tokens ?? 0;
    totalCacheWrite += finalMsg.usage.cache_creation_input_tokens ?? 0;
    model = finalMsg.model;
    stopReason = finalMsg.stop_reason ?? null;
    stepsUsed += 1;
  }

  return {
    assistantContent,
    assembledCases: registry.list(),
    citedCases: registry.toCitedCases(),
    toolTrace,
    tokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    },
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
    status: "success" | "error" | "fallback";
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
      cases_enriched: sessionStore.trace.cases_enriched,
      assistant_messages_scanned: sessionStore.trace.assistant_messages_scanned,
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
    "SESSION CASES (already cited earlier in this chat). Before calling search_fresh, check whether one of these already covers the question — if so, use load_case on it (with an aspect) instead of searching. Each entry shows what the case is about:",
  ];
  for (const s of store.caseSummaries) {
    const cite = s.citation ? ` — ${s.citation}` : "";
    lines.push(
      `  [${s.recency_rank}] ${s.title}${cite} (${s.source_table}:${s.source_id})`
    );
    if (s.issue) lines.push(`        issue: ${s.issue}`);
    else if (s.headnotes_snippet) lines.push(`        about: ${s.headnotes_snippet}`);
    if (s.acts_cited.length > 0) {
      lines.push(`        acts: ${s.acts_cited.slice(0, 6).join("; ")}`);
    }
  }
  return lines.join("\n");
}
