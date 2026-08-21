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
import { getAnthropicClient } from "../claude";
import { addClaudeUsage, currentCostInr } from "../billing/meter";
import { CREDIT_INR } from "../billing/cost";
import { decomposeQuestion } from "./decompose";
import { reflectSufficiency } from "./reflect";
import { gradeDraft, describeUnsupported, buildGroundingFooter, buildSupportByCase, type GradeResult } from "./faithfulness";
import { patchUnsupported } from "./groundingPatch";
import { ProgressiveGate } from "./progressiveGate";
import { PhaseTimer, phaseStepRecords, type PhaseRecord } from "./phaseTimer";
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

const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "claude-sonnet-5";
// Budget for tool-calling rounds. Legal synthesis often loads many cases, so
// this must be comfortably above the worst-case "one load per case" count.
// Parallel tool calls (handled below) usually keep the real count far lower.
const MAX_AGENT_STEPS = 10;
/**
 * Output cap per round. Raised from 4096 because multi-case answers were
 * silently truncating: a 7-case "summarise these with relevant paragraphs"
 * turn stopped at `max_tokens` mid-sentence after billing the user 44 credits
 * for the input side. This is a ceiling, not a target — a short answer still
 * costs what it costs, so the only turns that pay more are the ones that were
 * being cut off. Env-tunable to allow tightening without a deploy.
 */
const MAX_TOKENS_PER_STEP = numEnv("AGENT_MAX_TOKENS", 8192);
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
/**
 * Verify and release the answer a paragraph at a time (see progressiveGate.ts)
 * rather than generating it whole, grading it whole, then revealing it. Set
 * PROGRESSIVE_GROUNDING=off to fall back to the sequential gate.
 */
const progressive = (process.env.PROGRESSIVE_GROUNDING?.trim() || "on") !== "off";
/**
 * Per-request model tuning, applied to every agent round.
 *
 * `thinking` is set EXPLICITLY rather than omitted. On Sonnet 4.6 omitting it
 * meant no extended thinking; on Sonnet 5 omitting it runs adaptive thinking,
 * so a bare model swap would have silently added reasoning tokens to the
 * critical path and made the turn slower, not faster. Keeping it off preserves
 * the behaviour these prompts were tuned against, and makes the model change a
 * clean speed/capability upgrade rather than two changes at once. Turn it on
 * deliberately, with AGENT_EFFORT, once there are numbers to compare.
 */
const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
type Effort = (typeof EFFORT_LEVELS)[number];
const AGENT_EFFORT = EFFORT_LEVELS.find(
  (e) => e === process.env.AGENT_EFFORT?.trim()
) as Effort | undefined;
const MODEL_TUNING: Pick<
  Anthropic.MessageCreateParams,
  "thinking" | "output_config"
> = AGENT_EFFORT
  ? { thinking: { type: "adaptive" }, output_config: { effort: AGENT_EFFORT } }
  : { thinking: { type: "disabled" } };
/**
 * Per-question credit ceiling. Read live from the meter between steps, so a
 * pathological question winds down instead of walking every tool to the step
 * limit. Tuning MAX_AGENT_STEPS and the per-case char budget shapes the average
 * cost; only this bounds the tail.
 */
const CREDIT_BUDGET = numEnv("RESEARCH_CREDIT_BUDGET", 25);

/** Credits spent so far on the active metered turn (0 outside a meter). */
function creditsSpent(): number {
  return Math.ceil(currentCostInr() / CREDIT_INR);
}

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
   *  so the UI can show a status while the user waits for the verified answer.
   *  `writing` and `revising` cover the long stretch between the last tool call
   *  and the verified answer — without them the status line sits on the last
   *  tool's label for minutes while the model drafts. */
  onStatus?: (status: {
    phase: "researching" | "verifying" | "writing" | "revising";
  }) => void;
  /** Fires when the progressive gate has to retract text it already released
   *  (the round turned out to be a tool call). The client must discard every
   *  delta received for this assistant message so far. Rare — see
   *  ProgressiveGateOptions.onRollback. */
  onRollback?: () => void;
  /** Aborts the run when the client disconnects or hits Stop. Passed to every
   *  Anthropic stream so in-flight generation is cancelled, and checked between
   *  steps so no further model/tool work (or billing) happens after a cancel. */
  abortSignal?: AbortSignal;
}

/** Thrown when the client cancels mid-run; the route maps it to an unbilled abort. */
export class AgentAbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AgentAbortedError";
  }
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
  /** True when the credit ceiling forced the loop to stop researching early. */
  budgetHit: boolean;
  /** The ceiling that was in force, so `budgetHit` stays interpretable after a
   *  RESEARCH_CREDIT_BUDGET change. */
  creditBudget: number;
  /** In-loop grounding-gate outcome on the final answer (#5). Null if not run. */
  faithfulness: {
    ran: boolean;
    checked: number;
    unsupported: number;
    uncertain: number;
    revised: boolean;
    /** True when a grounding failure was repaired by patching the flagged
     *  sentences rather than regenerating the whole answer. */
    patched: boolean;
  } | null;
  /** Per-phase timings (model rounds, gates, revision) for the audit log. */
  phaseTrace: PhaseRecord[];
  /** Rendered view of the full system + user + tool messages, for audit only. */
  contextDebug: string;
}

function getClient(): Anthropic {
  return getAnthropicClient();
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const client = getClient();
  const registry = new CaseRegistry();
  const timer = new PhaseTimer();
  const toolTrace: ToolCallRecord[] = [];
  const ctx: ToolContext = {
    sessionStore: opts.sessionStore,
    sessionFilters: opts.sessionFilters,
    registry,
    trace: toolTrace,
    // Fresh per turn: the model's context is rebuilt each turn, so a chunk sent
    // last turn is not present in this one and must be sent again.
    emittedChunkIds: new Set<number>(),
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
    const decomposition = await timer.time(
      "decompose",
      () => decomposeQuestion(opts.userMessage),
      (d) => ({ is_compound: d.isCompound, sub_questions: d.subQuestions.length })
    );
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
  let budgetHit = false;
  let revisionBudget = GROUNDING_REVISIONS;
  let lastGrade: GradeResult | null = null;
  let revised = false;
  let patched = false;
  /**
   * Characters of `assistantContent` already released to the client by the
   * progressive gate. The final emit sends only what is left, so text is never
   * sent twice — and the footer, appended after the loop, still reaches the UI.
   */
  let releasedChars = 0;

  const accUsage = (u: Anthropic.Messages.Usage) => {
    totalInputTokens += u.input_tokens;
    totalOutputTokens += u.output_tokens;
    totalCacheRead += u.cache_read_input_tokens ?? 0;
    totalCacheWrite += u.cache_creation_input_tokens ?? 0;
    // Report the streamed Sonnet usage to the request meter (the proxy in
    // getAnthropicClient only auto-meters .create, not .stream).
    addClaudeUsage(CHAT_MODEL, u);
  };

  // Drafts are NOT streamed to the user as they generate; we suppress interim
  // text, run the reflect (#1) and grounding (#5) gates, and stream only the
  // accepted, verified answer at the end (draft → verify → stream).
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    // Bail out (unbilled) if the client disconnected or hit Stop between steps,
    // so we don't keep spending on tool rounds / generation for an abandoned turn.
    if (opts.abortSignal?.aborted) throw new AgentAbortedError();
    stepsUsed = step + 1;
    // Verify this round's prose a paragraph at a time, while it is still being
    // written, and release each paragraph as it clears. `gate` stays null until
    // text actually arrives, so a pure tool-calling round costs nothing.
    //
    // Releasing commits us to this answer, which rules out the reflect →
    // re-search path below (it discards the draft and searches again). Whether
    // reflect COULD fire is knowable before the round — it depends only on tool
    // results already gathered — so decide up front rather than releasing and
    // then suppressing the re-search. Measured 2026-08-21: suppressing it
    // instead cost 39% of the cases a turn loads, i.e. materially less evidence
    // behind the answer. Weak-retrieval rounds therefore fall back to the
    // sequential gate; every other round gets the full progressive path.
    const mayReflect =
      researchBudget > 0 && retrievalIsWeak(toolTrace) && creditsSpent() < CREDIT_BUDGET;
    const progressiveThisRound = progressive && !mayReflect;
    let gate: ProgressiveGate | null = null;
    const finalMsg = await timer.time(
      "model_round",
      async () => {
        const stream = client.messages.stream(
          {
            model: CHAT_MODEL,
            max_tokens: MAX_TOKENS_PER_STEP,
            system: cachedSystemPrompt,
            tools: TOOL_DEFINITIONS,
            messages: applyCacheBreakpoints(messages),
            ...MODEL_TUNING,
          },
          { signal: opts.abortSignal }
        );
        // Drafts are deliberately not shown to the user before the grounding
        // gate runs, but the moment text starts arriving we DO know the model
        // has stopped calling tools and is writing — which is the multi-minute
        // stretch the status line used to sit blank through. Announce it on the
        // first delta rather than guessing up front, so a round that turns out
        // to call more tools never briefly mislabels itself.
        let announcedWriting = false;
        stream.on("text", (delta: string) => {
          if (!announcedWriting) {
            announcedWriting = true;
            opts.onStatus?.({ phase: "writing" });
            if (progressiveThisRound) {
              let sawSubstance = false;
              gate = new ProgressiveGate({
                cases: registry.list(),
                transform: (part) => {
                  // Drop a leading "Understood, I will…" preamble before it can
                  // be released; once real content has arrived, stop checking.
                  if (!sawSubstance) {
                    if (isMetaParagraph(part.trim())) return null;
                    sawSubstance = true;
                  }
                  // Bare [n] → [^n] must happen before grading: the judge only
                  // matches caret markers, so an un-normalised paragraph would
                  // be silently graded as having no claims at all.
                  return normalizeCitations(part, registry.list().length).text;
                },
                onRelease: opts.onTextDelta,
                onVerifying: () => opts.onStatus?.({ phase: "verifying" }),
                onRollback: () => opts.onRollback?.(),
                abortSignal: opts.abortSignal,
              });
            }
          }
          gate?.push(delta);
        });
        // The moment a tool call appears, this round's text was narration and
        // not the answer — stop releasing it. The gate holds one paragraph
        // behind the writer precisely so this cancellation lands in time.
        stream.on("contentBlock", (block: Anthropic.ContentBlock) => {
          if (block.type === "tool_use") gate?.cancelRelease();
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
        return stream.finalMessage();
      },
      (msg) => ({
        step,
        stop_reason: msg.stop_reason,
        output_tokens: msg.usage.output_tokens,
        cache_read_tokens: msg.usage.cache_read_input_tokens ?? 0,
        tool_calls: msg.content.filter((b) => b.type === "tool_use").length,
      })
    );
    accUsage(finalMsg.usage);
    model = finalMsg.model;
    stopReason = finalMsg.stop_reason ?? null;

    if (finalMsg.stop_reason === "tool_use") {
      (gate as ProgressiveGate | null)?.cancelRelease();
      const toolUseBlocks = finalMsg.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (toolUseBlocks.length === 0) {
        assistantContent = textOf(finalMsg);
        break;
      }

      // Execute tools in parallel. Each executeTool call appends to toolTrace.
      // load_case's char budget is per ROUND, not per call, so the tools need to
      // know how many of them are sharing it — otherwise a fan-out of parallel
      // load_case calls multiplies the per-case cap by the batch size.
      const siblingLoadCases = toolUseBlocks.filter((b) => b.name === "load_case").length;
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
            ctx,
            { siblingLoadCases }
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

      // Credit ceiling. Appended alongside the tool results (they must answer
      // their tool_use blocks immediately) so the model writes a complete answer
      // from what it has rather than being cut off mid-research.
      const blocks: Anthropic.ContentBlockParam[] = [...toolResultBlocks];
      if (!budgetHit && creditsSpent() >= CREDIT_BUDGET) {
        budgetHit = true;
        blocks.push({
          type: "text",
          text:
            "You have used the research budget for this question. Stop calling tools and " +
            "write your answer now from the cases you already have. If the answer is " +
            "narrower than it would otherwise be, say so in one sentence at the end.",
        });
      }
      messages.push({ role: "user", content: blocks });
      continue;
    }

    // ── The model produced a DRAFT answer (end_turn / max_tokens). ──
    // Normalize bare [n] → caret [^n] BEFORE grading/streaming so the grounding
    // judge (which matches \[\^…\]) sees every citation and the streamed text is
    // already canonical.
    const draft = normalizeCitations(textOf(finalMsg), registry.list().length).text;
    messages.push({ role: "assistant", content: finalMsg.content });

    // Close the progressive gate for this round. Everything it released is
    // already verified and already on the user's screen.
    const gateResult = gate ? await (gate as ProgressiveGate).finish() : null;
    const committed = gateResult !== null && gateResult.releasedChars > 0;

    // #1 Reflect → re-search. Only when the model actually searched and the
    // results were weak, and there is re-search budget left. Skipped once text
    // has been committed to the user: re-searching would produce a different
    // answer, and the first paragraphs of the old one are already on screen.
    if (!committed && researchBudget > 0 && retrievalIsWeak(toolTrace) && creditsSpent() < CREDIT_BUDGET) {
      opts.onStatus?.({ phase: "researching" });
      const r = await timer.time(
        "reflect",
        () =>
          reflectSufficiency({
            userMessage: opts.userMessage,
            evidenceSummary: summarizeEvidence(registry.list()),
          }),
        (res) => ({ sufficient: res.sufficient, has_next_query: Boolean(res.nextQuery) })
      );
      if (!r.sufficient && r.nextQuery) {
        researchBudget--;
        messages.push({
          role: "user",
          content: `Before answering: the gathered evidence looks thin for this question. Run ONE more search_fresh for: "${r.nextQuery}". Then write your answer. Output ONLY the substantive answer itself — no preamble, no acknowledgement of this instruction, no commentary about your process.`,
        });
        continue;
      }
    }

    // #5a Progressive gate already graded and repaired this answer, paragraph by
    // paragraph, while it was being written. Nothing further to do — and nothing
    // further is *permitted*, since the text has been shown.
    if (gateResult && gateResult.ran) {
      lastGrade = {
        findings: gateResult.findings,
        unsupported: gateResult.unsupported,
        checked: gateResult.checked,
        ran: true,
      };
      revised = gateResult.patched;
      patched = gateResult.patched;
      releasedChars = gateResult.releasedChars;
      assistantContent = gateResult.text;
      break;
    }
    if (gateResult && !gateResult.ran) {
      // Uncited prose (or the judge failed). Take the gate's text so the
      // already-released characters and `assistantContent` cannot diverge.
      releasedChars = gateResult.releasedChars;
      assistantContent = gateResult.text;
      break;
    }

    // #5b Sequential grounding gate — the pre-progressive path, still used when
    // progressive release is disabled. Grade citation-bearing drafts; if claims
    // are unsupported and revision budget remains, send it back to be fixed.
    if (/\[\^\d+/.test(draft)) {
      opts.onStatus?.({ phase: "verifying" });
      lastGrade = await timer.time(
        "grounding_judge",
        () => gradeDraft(draft, registry.list()),
        (g) => ({ ran: g.ran, checked: g.checked, unsupported: g.unsupported.length })
      );
      if (lastGrade.ran && lastGrade.unsupported.length > 0 && revisionBudget > 0) {
        revisionBudget--;
        revised = true;
        opts.onStatus?.({ phase: "revising" });

        // Repair the flagged sentences in place rather than regenerating the
        // whole answer. Falls through to the full rewrite below when the patch
        // can't be made safely, so the gate's guarantee never weakens.
        const patch = await timer.time(
          "revision",
          () =>
            patchUnsupported({
              draft,
              unsupported: lastGrade!.unsupported,
              cases: registry.list(),
              abortSignal: opts.abortSignal,
            }),
          (p) => ({
            strategy: p ? "patch" : "fallback_rewrite",
            patched_claims: p?.patchedClaims.length ?? 0,
            unpatched_claims: p?.unpatchedClaims.length ?? 0,
          })
        );

        if (patch) {
          patched = true;
          // Re-grade ONLY the replacements. Untouched sentences are byte-identical
          // to the ones already graded, so their verdicts still stand.
          const regrade =
            patch.replacements.length > 0
              ? await timer.time(
                  "grounding_judge",
                  () => gradeDraft(patch.replacements.join("\n\n"), registry.list()),
                  (g) => ({
                    scope: "patched_claims",
                    ran: g.ran,
                    checked: g.checked,
                    unsupported: g.unsupported.length,
                  })
                )
              : null;
          lastGrade = mergeGrades(lastGrade, patch.patchedClaims, regrade);
          assistantContent = patch.text;
          break;
        }

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

    const finalStream = client.messages.stream(
      {
        model: CHAT_MODEL,
        max_tokens: MAX_TOKENS_PER_STEP,
        system: cachedSystemPrompt,
        tool_choice: { type: "none" },
        tools: TOOL_DEFINITIONS,
        messages: applyCacheBreakpoints(messages),
      },
      { signal: opts.abortSignal }
    );
    finalStream.on("error", (err: unknown) => {
      logError({
        category: "fetching",
        message: err instanceof Error ? err.message : String(err),
        error: err,
        severity: "critical",
        metadata: { phase: "forced_synthesis", model: CHAT_MODEL },
      });
    });
    const finalMsg = await timer.time(
      "model_round",
      () => finalStream.finalMessage(),
      (msg) => ({
        phase: "forced_synthesis",
        stop_reason: msg.stop_reason,
        output_tokens: msg.usage.output_tokens,
      })
    );
    accUsage(finalMsg.usage);
    model = finalMsg.model;
    stopReason = finalMsg.stop_reason ?? null;
    stepsUsed += 1;
    assistantContent = normalizeCitations(textOf(finalMsg), registry.list().length).text;
    if (/\[\^\d+/.test(assistantContent)) {
      opts.onStatus?.({ phase: "verifying" });
      lastGrade = await timer.time(
        "grounding_judge",
        () => gradeDraft(assistantContent, registry.list()),
        (g) => ({ scope: "forced_synthesis", ran: g.ran, checked: g.checked, unsupported: g.unsupported.length })
      );
    }
  }

  // Belt-and-suspenders: drop a leading meta/preamble paragraph if the model
  // acknowledged an internal revision/reflection nudge ("Understood, I will…")
  // instead of starting with the answer. Conservative — only strips a short
  // leading line matching known openers when substantive content follows.
  // Skipped once text has been released: the gate already dropped preambles per
  // paragraph, and re-stripping here would desynchronise `releasedChars`.
  if (releasedChars === 0) assistantContent = stripLeadingMeta(assistantContent);

  // Append the groundedness footer for any claims still unsupported after the
  // revision budget was spent (the in-loop gate already tried to fix them).
  if (lastGrade && lastGrade.ran && lastGrade.unsupported.length > 0) {
    assistantContent += buildGroundingFooter(lastGrade.unsupported, registry.list());
  }

  // Emit whatever the progressive gate has not already released — the tail of
  // the answer plus the groundedness footer. When progressive release is off
  // (or the round never produced verified prose) `releasedChars` is 0 and this
  // sends the whole answer, exactly as before: verified first, then streamed in
  // small chunks so the UI paints progressively instead of dumping one blob.
  const pending = assistantContent.slice(releasedChars);
  if (pending) emitChunked(pending, opts.onTextDelta);

  const faithfulness = lastGrade
    ? {
        ran: lastGrade.ran,
        checked: lastGrade.checked,
        unsupported: lastGrade.unsupported.length,
        uncertain: lastGrade.findings.filter((f) => f.verdict === "uncertain").length,
        revised,
        patched,
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
    phaseTrace: timer.list(),
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
    budgetHit,
    creditBudget: CREDIT_BUDGET,
    contextDebug: JSON.stringify(
      { session_cases_count: opts.sessionStore.caseSummaries.length, history_turns: messages.length },
      null,
      2
    ),
  };
}

/**
 * Fold a re-grade of patched sentences back into the original grade.
 *
 * After a surgical grounding patch only the replaced sentences changed, so the
 * original findings still describe every untouched sentence accurately. We drop
 * the findings for the claims we replaced and add the verdicts for their
 * replacements. A patched claim whose replacement could not be re-graded (the
 * judge failed, or the replacement carried no citation to check) is simply gone
 * from the findings — it no longer exists in the answer.
 */
function mergeGrades(
  original: GradeResult,
  patchedClaims: string[],
  regrade: GradeResult | null
): GradeResult {
  const replaced = new Set(patchedClaims);
  const kept = original.findings.filter((f) => !replaced.has(f.claim));
  const findings = [...kept, ...(regrade?.ran ? regrade.findings : [])];
  return {
    findings,
    unsupported: findings.filter((f) => f.verdict === "unsupported"),
    // `checked` counts claims actually judged this turn, across both passes.
    checked: original.checked + (regrade?.checked ?? 0),
    ran: original.ran,
  };
}

/**
 * Adapter: convert the agent's tool-call trace into PipelineStepRecord rows
 * for rag_pipeline_steps. Shape:
 *   step_order 1        = agent_start (what the agent saw as it began)
 *   step_order 2..N+1   = tool_call   (one per tool invocation, in order)
 *   step_order N+2..M   = per-phase timings (model_round, reflect, judge, …)
 *   step_order M+1      = turn_total  (end-to-end request wall clock)
 *
 * `turn_total` is the whole-request number that used to be written to the
 * `generate` row — where it double-counted every tool row above it and hid the
 * fact that nothing inside the loop was timed at all. The phase rows are the
 * actual breakdown; `generate` now means only the model calls that produced
 * answer text, and is derived from those rows.
 */
export function buildAgentAuditSteps(params: {
  userMessage: string;
  sessionStore: SessionDocumentStore;
  toolTrace: ToolCallRecord[];
  phaseTrace?: PhaseRecord[];
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
  const phaseTrace = params.phaseTrace ?? [];
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

  // Per-phase timings, in the order they happened.
  const phaseRows = phaseStepRecords(phaseTrace, toolTrace.length + 2);
  steps.push(...phaseRows);

  // Model time that produced answer text, summed from the measured rounds. This
  // is what `generate` should always have meant.
  const modelMs = phaseTrace
    .filter((p) => p.phase === "model_round")
    .reduce((sum, p) => sum + p.duration_ms, 0);
  const toolMs = toolTrace.reduce((sum, t) => sum + t.duration_ms, 0);
  const rollup: Record<string, number> = {};
  for (const p of phaseTrace) rollup[p.phase] = (rollup[p.phase] ?? 0) + p.duration_ms;

  steps.push({
    step_order: toolTrace.length + 2 + phaseRows.length,
    step: "turn_total",
    status: generate.status,
    duration_ms: generate.duration_ms,
    started_at: generate.started_at,
    error: generate.error,
    data: {
      ...generate.data,
      // Everything needed to read the turn at a glance without joining rows.
      model_ms: modelMs,
      // Tool time SUMMED — tools run concurrently, so this exceeds wall clock.
      // Compare against turn duration to see how much overlap you're getting.
      tool_ms_summed: toolMs,
      phase_ms: rollup,
      tool_calls: toolTrace.length,
    },
  });

  return steps;
}

/**
 * True when a leading paragraph is process/meta narration (the model talking
 * about its tools or its own steps) rather than the substantive legal answer.
 * The final answer is formal, impersonal legal writing, so first-person openers
 * ("I now have…", "I will reconstruct…") and tool-name mentions are reliable
 * tells — even when the paragraph also contains a citation marker.
 */
function isMetaParagraph(p: string): boolean {
  if (/^#{1,6}\s/.test(p)) return false; // markdown heading → the real answer
  if (/^>/.test(p)) return false; // the "> NOTE:" grounding banner → real
  // Process/framing openers. Legal answers are impersonal and start with
  // doctrine or a heading, never "I …" or "This is a rich set of authorities".
  if (
    /^(i\b|i['’](?:ll|ve|m)|understood\b|got it\b|sure\b|okay\b|ok\b|let me\b|here(?:'s| is)\b|based on\b|this is (?:a |an )?(?:rich|comprehensive|strong|good|helpful|useful|solid|robust|clear|detailed|nice)\b)/i.test(p)
  ) {
    return true;
  }
  // Mentions of the retrieval machinery or step/process narration. Multi-word
  // phrases are used so genuine legal prose (e.g. "excerpts of the lease") is
  // not caught — only talk about THIS system's search/tools is. No length cap:
  // a long paragraph of process narration is still process narration.
  return /\b(load_case|search_fresh|lookup_by_citation|expand_cited_cases|the initial search|search results|already retrieved|passages?(?: that were| already)? retrieved|i (?:now )?have (?:sufficient|comprehensive|the|all|full|enough)|i now have|i can see (?:clearly|from|that)|i will (?:now )?(?:reconstruct|compose|provide|give|answer)|the cases surfaced|reconstruct the answer|here is (?:a |my |the )?(?:comprehensive|doctrinal|detailed|brief)?\s*(?:overview|summary|analysis)\b)/i.test(p);
}

/**
 * Strip leading process/meta paragraphs the model sometimes emits when replying
 * to an internal revision/reflection nudge, so they don't leak into the answer.
 * Walks paragraphs from the top, dropping meta ones until the first substantive
 * paragraph (or heading/banner). Safety rails: never drops the only remaining
 * paragraph, and returns the original if stripping would gut the answer.
 * Exported for unit testing.
 */
export function stripLeadingMeta(text: string): string {
  const paras = text.replace(/^\s+/, "").split(/\n\n+/);
  let i = 0;
  while (i < paras.length - 1 && isMetaParagraph(paras[i].trim())) i++;
  if (i === 0) return text;
  const rest = paras.slice(i).join("\n\n").trimStart();
  return rest.length > 150 ? rest : text;
}

/**
 * Emit a completed answer as a sequence of small deltas so the client renders it
 * progressively instead of in one jarring repaint. Splits on word boundaries
 * into ~modest pieces; the route still sends an authoritative `done` payload, so
 * exact chunk boundaries don't matter for correctness.
 */
function emitChunked(text: string, onTextDelta: (delta: string) => void): void {
  const CHUNK = 240; // chars; ~a sentence or two per frame
  if (text.length <= CHUNK) {
    onTextDelta(text);
    return;
  }
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK, text.length);
    if (end < text.length) {
      // Prefer to break at the next whitespace so we don't split words/markers.
      const ws = text.indexOf(" ", end);
      if (ws !== -1 && ws - end < 60) end = ws + 1;
    }
    onTextDelta(text.slice(i, end));
    i = end;
  }
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
