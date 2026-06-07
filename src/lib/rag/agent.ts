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
import { reflectSufficiency } from "./reflect";
import { gradeDraft, describeUnsupported, buildGroundingFooter, buildSupportByCase, type GradeResult } from "./faithfulness";
import { normalizeCitations } from "./citationNormalizer";
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
// #1 Adaptive re-search budget (balanced) and the rerank score below which
// retrieval is considered "weak" enough to reflect on.
const MAX_RESEARCHES = numEnv("MAX_RESEARCH_RESEARCHES", 2);
const REFLECT_WEAK_THRESHOLD = 0.45;
// #5 How many times a draft may be sent back for grounding revision.
const GROUNDING_REVISIONS = numEnv("GROUNDING_MAX_REVISIONS", 1);

function numEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

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
  /** Fires when the loop enters a non-streaming gate (re-search / verification)
   *  so the UI can show a status while the user waits for the verified answer. */
  onStatus?: (status: { phase: "researching" | "verifying" }) => void;
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
  /** In-loop grounding-gate outcome on the final answer (#5). Null if not run. */
  faithfulness: {
    ran: boolean;
    checked: number;
    unsupported: number;
    uncertain: number;
    revised: boolean;
  } | null;
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
  let researchBudget = MAX_RESEARCHES;
  let revisionBudget = GROUNDING_REVISIONS;
  let lastGrade: GradeResult | null = null;
  let revised = false;

  const accUsage = (u: Anthropic.Messages.Usage) => {
    totalInputTokens += u.input_tokens;
    totalOutputTokens += u.output_tokens;
    totalCacheRead += u.cache_read_input_tokens ?? 0;
    totalCacheWrite += u.cache_creation_input_tokens ?? 0;
  };

  // Drafts are NOT streamed to the user as they generate; we suppress interim
  // text, run the reflect (#1) and grounding (#5) gates, and stream only the
  // accepted, verified answer at the end (draft → verify → stream).
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    stepsUsed = step + 1;
    const stream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS_PER_STEP,
      system: cachedSystemPrompt,
      tools: TOOL_DEFINITIONS,
      messages: applyCacheBreakpoints(messages),
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
    accUsage(finalMsg.usage);
    model = finalMsg.model;
    stopReason = finalMsg.stop_reason ?? null;

    if (finalMsg.stop_reason === "tool_use") {
      const toolUseBlocks = finalMsg.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (toolUseBlocks.length === 0) {
        assistantContent = textOf(finalMsg);
        break;
      }

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
          const finalRecord = toolTrace[toolTrace.length - 1];
          opts.onToolEvent({ type: "end", step_index: step, record: finalRecord });
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: resultText,
          };
        })
      );

      if (registry.list().length !== lastCasesCount) {
        lastCasesCount = registry.list().length;
        opts.onCasesUpdate(registry.toCitedCases());
      }

      messages.push({ role: "assistant", content: finalMsg.content });
      messages.push({ role: "user", content: toolResultBlocks });
      continue;
    }

    // ── The model produced a DRAFT answer (end_turn / max_tokens). ──
    // Normalize bare [n] → caret [^n] BEFORE grading/streaming so the grounding
    // judge (which matches \[\^…\]) sees every citation and the streamed text is
    // already canonical.
    const draft = normalizeCitations(textOf(finalMsg), registry.list().length).text;
    messages.push({ role: "assistant", content: finalMsg.content });

    // #1 Reflect → re-search. Only when the model actually searched and the
    // results were weak, and there is re-search budget left.
    if (researchBudget > 0 && retrievalIsWeak(toolTrace)) {
      opts.onStatus?.({ phase: "researching" });
      const r = await reflectSufficiency({
        userMessage: opts.userMessage,
        evidenceSummary: summarizeEvidence(registry.list()),
      });
      if (!r.sufficient && r.nextQuery) {
        researchBudget--;
        messages.push({
          role: "user",
          content: `Before answering: the gathered evidence looks thin for this question. Run ONE more search_fresh for: "${r.nextQuery}". Then write your answer. Output ONLY the substantive answer itself — no preamble, no acknowledgement of this instruction, no commentary about your process.`,
        });
        continue;
      }
    }

    // #5 Grounding gate. Grade citation-bearing drafts; if claims are
    // unsupported and revision budget remains, send it back to be fixed.
    if (/\[\^\d+/.test(draft)) {
      opts.onStatus?.({ phase: "verifying" });
      lastGrade = await gradeDraft(draft, registry.list());
      if (lastGrade.ran && lastGrade.unsupported.length > 0 && revisionBudget > 0) {
        revisionBudget--;
        revised = true;
        messages.push({
          role: "user",
          content:
            "Before finalising, fix grounding. These cited statements are NOT supported by the excerpt of the case they cite:\n" +
            describeUnsupported(lastGrade.unsupported) +
            "\n\nRevise so every cited claim is supported by the case it cites: correct the statement, cite a different loaded case, use load_case / expand_cited_cases / search_fresh to find support, or remove the claim. Then output ONLY the complete corrected final answer — start directly with the substantive content. Do NOT acknowledge this instruction, do not write 'Understood' or 'I will…', and include no preamble or commentary about your process.",
        });
        continue;
      }
    }

    assistantContent = draft;
    break;
  }

  // Forced final synthesis. If the loop exited while still in `tool_use` (i.e.
  // the agent exhausted MAX_AGENT_STEPS on retrieval and never wrote an answer),
  // make one more call with tools DISABLED so the model is compelled to answer
  // from the context it already gathered.
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
        "You have gathered enough context. Provide your final answer now using ONLY the cases already loaded above. Do not call any more tools. Output ONLY the substantive answer — no preamble, acknowledgement, or commentary about your process.",
    });

    const finalStream = client.messages.stream({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS_PER_STEP,
      system: cachedSystemPrompt,
      tool_choice: { type: "none" },
      tools: TOOL_DEFINITIONS,
      messages: applyCacheBreakpoints(messages),
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
    accUsage(finalMsg.usage);
    model = finalMsg.model;
    stopReason = finalMsg.stop_reason ?? null;
    stepsUsed += 1;
    assistantContent = normalizeCitations(textOf(finalMsg), registry.list().length).text;
    if (/\[\^\d+/.test(assistantContent)) {
      lastGrade = await gradeDraft(assistantContent, registry.list());
    }
  }

  // Belt-and-suspenders: drop a leading meta/preamble paragraph if the model
  // acknowledged an internal revision/reflection nudge ("Understood, I will…")
  // instead of starting with the answer. Conservative — only strips a short
  // leading line matching known openers when substantive content follows.
  assistantContent = stripLeadingMeta(assistantContent);

  // Append the groundedness footer for any claims still unsupported after the
  // revision budget was spent (the in-loop gate already tried to fix them).
  if (lastGrade && lastGrade.ran && lastGrade.unsupported.length > 0) {
    assistantContent += buildGroundingFooter(lastGrade.unsupported, registry.list());
  }

  // Stream the accepted, verified answer to the client now.
  if (assistantContent) opts.onTextDelta(assistantContent);

  const faithfulness = lastGrade
    ? {
        ran: lastGrade.ran,
        checked: lastGrade.checked,
        unsupported: lastGrade.unsupported.length,
        uncertain: lastGrade.findings.filter((f) => f.verdict === "uncertain").length,
        revised,
      }
    : null;

  // Attach the verified supporting passages (Design A) to the cited-case payload
  // so the citation panel can show exactly where each grounded statement came
  // from — keyed by AssembledCase.index, which the judge's findings reference.
  const citedCases = registry.toCitedCases();
  if (lastGrade && lastGrade.ran) {
    const supportByIndex = buildSupportByCase(lastGrade.findings);
    if (supportByIndex.size > 0) {
      const indexByKey = new Map(
        registry.list().map((c) => [`${c.source_table}:${c.source_id}`, c.index])
      );
      for (const cc of citedCases) {
        const idx = indexByKey.get(`${cc.source_table}:${cc.id}`);
        const spans = idx ? supportByIndex.get(idx) : undefined;
        if (spans && spans.length > 0) cc.support = spans;
      }
    }
  }

  return {
    assistantContent,
    faithfulness,
    assembledCases: registry.list(),
    citedCases,
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

// Leading-meta openers the model sometimes emits when replying to an internal
// revision/reflection nudge. Matched case-insensitively at the very start.
const META_OPENERS =
  /^(understood\b|got it\b|sure\b|okay\b|ok\b|i (will|'ll|now have|can see|have gathered)|let me\b|here(?:'s| is) (?:the|my)\b|based on the (?:tool results|cases|evidence)\b|i have (?:now )?(?:gathered|reviewed|loaded))/i;

/**
 * Strip a single leading meta/preamble paragraph if it acknowledges an internal
 * instruction rather than starting the answer. Conservative: only removes the
 * first block (up to the first blank line) when it matches a known opener, is
 * short (< 320 chars), carries no citation marker, and substantive content
 * remains afterward. Exported for unit testing.
 */
export function stripLeadingMeta(text: string): string {
  const trimmed = text.trimStart();
  const splitAt = trimmed.indexOf("\n\n");
  if (splitAt === -1) return text;
  const head = trimmed.slice(0, splitAt).trim();
  const rest = trimmed.slice(splitAt + 2).trimStart();
  if (
    head.length < 320 &&
    rest.length > 200 &&
    !/\[\^\d+/.test(head) &&
    META_OPENERS.test(head)
  ) {
    return rest;
  }
  return text;
}

/** Concatenate the text blocks of a model message. */
function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * #1 Weak-retrieval signal: true when the agent ran search_fresh but none of
 * those searches produced an on-point result (all abstained or scored below the
 * threshold). Pure load_case / meta flows (no search_fresh) are never "weak".
 */
function retrievalIsWeak(trace: ToolCallRecord[]): boolean {
  const searches = trace.filter((t) => t.tool === "search_fresh");
  if (searches.length === 0) return false;
  const anyStrong = searches.some((t) => {
    const ts = (t.data as { top_score?: unknown }).top_score;
    const abstained = (t.data as { abstained?: unknown }).abstained === true;
    return typeof ts === "number" && ts >= REFLECT_WEAK_THRESHOLD && !abstained;
  });
  return !anyStrong;
}

/** Compact list of gathered cases for the reflection judge. */
function summarizeEvidence(cases: AssembledCase[]): string {
  if (cases.length === 0) return "(no cases gathered)";
  return cases
    .map((c) => {
      const cite = c.extraction.extracted_citation ?? c.meta.citation;
      return `- ${c.meta.title || "(untitled)"}${cite ? ` (${cite})` : ""}`;
    })
    .join("\n");
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
