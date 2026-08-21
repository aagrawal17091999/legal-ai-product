/**
 * Workspace document agent.
 *
 * Replaces the corpus-size-driven full / mapreduce / retrieval modes with a
 * tool-using loop: the model decides what to read. Cost then tracks the
 * difficulty of the QUESTION rather than the size of the workspace, which is
 * what removes the cliff where uploading one more PDF silently tripled the
 * price of every subsequent question.
 *
 * Modelled on the case-law agent in rag/agent.ts — same prompt-cache shape
 * (cached system + tools, rolling breakpoint on the growing message list) and
 * the same rule that every streamed call reports its usage explicitly, because
 * the metering proxy in claude.ts only wraps `.create`, not `.stream`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../claude";
import { addClaudeUsage, currentCostInr } from "../billing/meter";
import { CREDIT_INR } from "../billing/cost";
import { cachedSystem, applyCacheBreakpoints } from "../rag/promptCache";
import { logError } from "../error-logger";
import { DOC_AGENT_SYSTEM_PROMPT } from "./docAgentPrompt";
import {
  DOC_TOOL_DEFINITIONS,
  ChunkRegistry,
  executeDocTool,
  type DocToolCallRecord,
  type DocToolContext,
} from "./docAgentTools";
import type { DocChunkHit } from "./retrieve";

const numEnv = (name: string, fallback: number): number => {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "claude-sonnet-4-6";
/**
 * Doc chat shares the CHAT_MODEL env var with the research agent, so pointing
 * that variable at Sonnet 5 changes this feature too. On Sonnet 4.6 omitting
 * `thinking` meant no extended thinking; on Sonnet 5 omitting it runs ADAPTIVE
 * thinking — which would quietly add reasoning tokens to every doc-chat round.
 * Disable it explicitly so the behaviour is the same on either model.
 */
const THINKING_OFF = { thinking: { type: "disabled" } } as const;
const MAX_STEPS = numEnv("DOC_AGENT_MAX_STEPS", 8);
/**
 * Output cap per round. Doubled alongside the research agent's: multi-document
 * answers were liable to the same silent truncation at `max_tokens`. A ceiling,
 * not a target — short answers are unaffected.
 */
const MAX_TOKENS_PER_STEP = numEnv("DOC_AGENT_MAX_TOKENS", 8192);
const HISTORY_TURNS = 10;

/**
 * Per-question credit ceiling. When measured spend crosses this mid-loop the
 * agent is told to stop researching and answer from what it already has. Tuning
 * bounds the average; only this bounds the tail — a pathological question can
 * otherwise walk every tool to the step limit.
 */
const CREDIT_BUDGET = numEnv("DOC_AGENT_CREDIT_BUDGET", 25);

export interface DocAgentTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DocAgentOptions {
  workspaceId: string;
  userMessage: string;
  history: DocAgentTurn[];
  onTextDelta: (delta: string) => void;
  onStatus?: (status: { phase: "reading" | "retrieving" | "answering" }) => void;
  /**
   * Aborts the run when the user presses Stop. This is NOT the request's
   * signal — a client that merely disconnects must not cancel the turn (see
   * lib/turns/durableTurns.ts).
   */
  abortSignal?: AbortSignal;
}

/** Thrown when a run is stopped on purpose, so callers can tell it from a fault. */
export class DocAgentAbortedError extends Error {
  constructor() {
    super("doc agent aborted");
    this.name = "DocAgentAbortedError";
  }
}

export interface DocAgentResult {
  assistantContent: string;
  chunks: DocChunkHit[];
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  toolCalls: DocToolCallRecord[];
  stepsUsed: number;
  budgetHit: boolean;
  /** The ceiling in force, so `budgetHit` stays interpretable after a
   *  DOC_AGENT_CREDIT_BUDGET change. */
  creditBudget: number;
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export async function runDocAgent(opts: DocAgentOptions): Promise<DocAgentResult> {
  const client = getAnthropicClient();
  const registry = new ChunkRegistry();
  const ctx: DocToolContext = { workspaceId: opts.workspaceId, registry };
  const toolCalls: DocToolCallRecord[] = [];

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let model = CHAT_MODEL;
  let budgetHit = false;
  let stepsUsed = 0;

  const accUsage = (u: Anthropic.Messages.Usage) => {
    totalInput += u.input_tokens;
    totalOutput += u.output_tokens;
    totalCacheRead += u.cache_read_input_tokens ?? 0;
    totalCacheWrite += u.cache_creation_input_tokens ?? 0;
    // .stream() is not auto-metered by the client proxy — report it here or the
    // whole turn bills as zero.
    addClaudeUsage(CHAT_MODEL, u);
  };

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: opts.userMessage },
  ];

  const system = cachedSystem(DOC_AGENT_SYSTEM_PROMPT);
  let answer = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    // Bail out (unbilled) if the user hit Stop between steps, so we don't keep
    // spending on tool rounds and generation for an abandoned turn.
    if (opts.abortSignal?.aborted) throw new DocAgentAbortedError();
    stepsUsed = step + 1;

    // Interim steps are not streamed to the user: the model narrates its tool
    // plan between calls, and only the final answer should reach the UI.
    const isLikelyFinal = step > 0 && toolCalls.length > 0;
    if (opts.onStatus) {
      opts.onStatus({ phase: step === 0 ? "retrieving" : isLikelyFinal ? "answering" : "reading" });
    }

    const stream = client.messages.stream(
      {
        model: CHAT_MODEL,
        max_tokens: MAX_TOKENS_PER_STEP,
        system,
        tools: DOC_TOOL_DEFINITIONS,
        messages: applyCacheBreakpoints(messages),
        ...THINKING_OFF,
      },
      { signal: opts.abortSignal }
    );
    stream.on("error", (err: unknown) => {
      logError({
        category: "fetching",
        message: err instanceof Error ? err.message : String(err),
        error: err,
        severity: "critical",
        metadata: { step, model: CHAT_MODEL, feature: "docagent" },
      });
    });

    const finalMsg = await stream.finalMessage();
    accUsage(finalMsg.usage);
    model = finalMsg.model;

    if (finalMsg.stop_reason !== "tool_use") {
      answer = textOf(finalMsg);
      break;
    }

    const toolUses = finalMsg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) {
      answer = textOf(finalMsg);
      break;
    }

    messages.push({ role: "assistant", content: finalMsg.content });

    // Tool calls in one assistant turn are independent — run them together and
    // return every result in a single user message, as the API requires.
    const results = await Promise.all(
      toolUses.map(async (t) => {
        const { text, record } = await executeDocTool(ctx, t.name, t.input);
        toolCalls.push(record);
        return { tool_use_id: t.id, text };
      })
    );

    const resultBlocks: Anthropic.ContentBlockParam[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.tool_use_id,
      content: r.text,
    }));

    // Budget check between steps. Warn once, in-band, rather than truncating:
    // an agent told to wrap up writes a complete answer from what it has, where
    // a hard cut leaves the user with nothing for the credits already spent.
    const spentCredits = Math.ceil(currentCostInr() / CREDIT_INR);
    if (!budgetHit && spentCredits >= CREDIT_BUDGET) {
      budgetHit = true;
      // Append the wind-down instruction to the same user turn as the tool
      // results — the API requires tool results to answer their tool_use blocks
      // immediately, and a trailing text block is the supported way to add
      // guidance alongside them.
      resultBlocks.push({
        type: "text",
        text:
          "You have used the research budget for this question. Stop calling tools and " +
          "answer now from the passages you already have. If your answer is incomplete " +
          "because of this, say so in one sentence at the end.",
      });
    }

    messages.push({ role: "user", content: resultBlocks });
  }

  // The loop ended without the model producing prose (step limit reached mid
  // research). Ask once for an answer from what was gathered, with tools off so
  // it cannot start another round.
  if (!answer) {
    if (opts.abortSignal?.aborted) throw new DocAgentAbortedError();
    const closing = client.messages.stream(
      {
        model: CHAT_MODEL,
        max_tokens: MAX_TOKENS_PER_STEP,
        system,
        ...THINKING_OFF,
        messages: applyCacheBreakpoints([
          ...messages,
          {
            role: "user",
            content:
              "Answer the question now using only the passages above. Do not request more.",
          },
        ]),
      },
      { signal: opts.abortSignal }
    );
    const finalMsg = await closing.finalMessage();
    accUsage(finalMsg.usage);
    answer = textOf(finalMsg);
  }

  // Stream the accepted answer to the client in one pass. The loop's interim
  // narration is deliberately withheld, so this is the first text the user sees.
  if (answer) opts.onTextDelta(answer);

  return {
    assistantContent: answer,
    chunks: registry.all(),
    model,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
    },
    toolCalls,
    stepsUsed,
    budgetHit,
    creditBudget: CREDIT_BUDGET,
  };
}
