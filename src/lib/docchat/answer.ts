/**
 * Document-workspace chat (Feature 1).
 *
 * Pipeline: the agent reads the workspace with tools → answers only from what it
 * read → the citations are verified against their source passages.
 *
 * This file used to pick one of three grounding strategies by CORPUS SIZE —
 * `full` (send every chunk), `mapreduce` (Haiku-summarise blocks, then
 * synthesise), or `retrieval` (top-K). That design made the price of a question
 * a function of how many documents the user had uploaded rather than what they
 * asked, with a cliff at the single-pass threshold where the same question
 * abruptly cost 4x and started answering from summaries instead of source text.
 *
 * It is now one path: runDocAgent (see docAgent.ts) lets the model choose what
 * to read — search for relevance, scan for completeness, section/document reads
 * for depth. Measured against the eval set in eval/docchat_set.json, that held
 * quality at 22/22 while cutting total credits 315 → 164.
 *
 * Citations always carry the chunk_id, so the source panel can show the real,
 * cleaned document text and the grounding pass can flag anything unsupported.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../claude";
import { logError } from "../error-logger";
import { runDocAgent } from "./docAgent";
import type { DocChunkHit } from "./retrieve";

/** Cheap model for the citation-grounding pass. */
const FAST_MODEL = process.env.DOC_FAST_MODEL?.trim() || "claude-haiku-4-5";
const VERIFY_ENABLED = (process.env.DOC_VERIFY ?? "on").trim().toLowerCase() !== "off";

export interface DocCitation {
  ref: number;
  chunk_id: number;
  document_id: string;
  document_name: string;
  page_no: number | null;
  snippet: string;
  support_quote?: string | null;
  verified?: boolean;
}

export interface DocChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type DocChatPhase = "retrieving" | "reading" | "answering" | "verifying";

export interface DocChatRunOptions {
  workspaceId: string;
  userMessage: string;
  history: DocChatTurn[];
  onTextDelta: (delta: string) => void;
  onStatus?: (status: { phase: DocChatPhase }) => void;
  /** Aborts on an explicit Stop — never on a mere client disconnect. */
  abortSignal?: AbortSignal;
}

export interface DocChatResult {
  assistantContent: string;
  citations: DocCitation[];
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  retrievedCount: number;
  topScore: number;
  groundedFromContext: boolean;
  /** Retained for the trace viewer; historical rows still carry the old modes. */
  mode: "full" | "mapreduce" | "retrieval" | "agent";
  /** True when the per-question credit ceiling stopped the agent researching
   *  early. Surfaced so the throttle is measurable — it was computed and
   *  discarded, so there was no way to tell how often answers were narrowed. */
  budgetHit: boolean;
  /** The ceiling in force, so `budgetHit` survives a threshold change. */
  creditBudget: number;
}

/** Whitespace-insensitive substring check, for validating verbatim quotes. */
function containsNormalized(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(haystack).includes(norm(needle));
}

/**
 * Grounding pass: for each cited source, extract the verbatim passage that backs
 * the answer (or mark it unsupported). Best-effort; failures leave citations
 * unverified rather than blocking. Quotes not actually present in their chunk
 * are dropped to keep the panel honest.
 */
async function verifyCitations(
  client: Anthropic,
  answer: string,
  citations: DocCitation[],
  chunkById: Map<number, DocChunkHit>
): Promise<DocCitation[]> {
  if (citations.length === 0) return citations;
  const sources = citations
    .map((c) => `[${c.ref}] ${chunkById.get(c.chunk_id)?.chunk_text ?? c.snippet}`)
    .join("\n\n---\n\n");
  try {
    const msg = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 1500,
      system:
        'You verify whether an answer is grounded in its cited sources. For each numbered source, decide if it actually supports the statements in the answer that cite it, and copy the single most relevant VERBATIM sentence or phrase (max ~300 chars) from that source. Respond with ONLY JSON: {"citations":[{"ref":1,"supported":true,"quote":"..."}]}. The quote MUST be copied character-for-character from the source. If a source does not support its claim, set supported=false and quote="".',
      messages: [{ role: "user", content: `ANSWER:\n${answer}\n\nSOURCES:\n${sources}` }],
    });
    const raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s === -1 || e === -1) return citations;
    const parsed = JSON.parse(raw.slice(s, e + 1)) as {
      citations?: Array<{ ref?: number; supported?: boolean; quote?: string }>;
    };
    const byRef = new Map<number, { supported?: boolean; quote?: string }>();
    for (const v of parsed.citations ?? []) {
      if (typeof v.ref === "number") byRef.set(v.ref, v);
    }
    return citations.map((c) => {
      const v = byRef.get(c.ref);
      if (!v) return c;
      const chunkText = chunkById.get(c.chunk_id)?.chunk_text ?? c.snippet;
      const quote = (v.quote ?? "").trim();
      const validQuote = quote && containsNormalized(chunkText, quote) ? quote : null;
      return { ...c, verified: v.supported === true, support_quote: validQuote };
    });
  } catch {
    return citations;
  }
}

export async function runDocChat(opts: DocChatRunOptions): Promise<DocChatResult> {
  const client = getAnthropicClient();

  let result;
  try {
    result = await runDocAgent({
      workspaceId: opts.workspaceId,
      userMessage: opts.userMessage,
      history: opts.history,
      onTextDelta: opts.onTextDelta,
      onStatus: (s) => opts.onStatus?.(s),
      abortSignal: opts.abortSignal,
    });
  } catch (err) {
    logError({
      category: "chat",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      metadata: { feature: "docchat", workspaceId: opts.workspaceId },
    });
    throw err;
  }

  // Citations come from the agent's ChunkRegistry, which numbered chunks as the
  // tools surfaced them — the same numbers the model was shown, so refs cannot
  // drift between what it cited and what the panel displays.
  const citations: DocCitation[] = result.chunks.map((c, i) => ({
    ref: i + 1,
    chunk_id: c.chunk_id,
    document_id: c.document_id,
    document_name: c.document_name,
    page_no: c.page_no,
    snippet: c.chunk_text.slice(0, 320),
  }));
  const chunkById = new Map(result.chunks.map((c) => [c.chunk_id, c]));

  // Keep only the citations the model actually referenced.
  const usedRefs = new Set<number>();
  for (const m of result.assistantContent.matchAll(/\[(\d+)\]/g)) {
    usedRefs.add(parseInt(m[1], 10));
  }
  let usedCitations =
    usedRefs.size > 0 ? citations.filter((c) => usedRefs.has(c.ref)) : citations;

  // A stopped turn keeps whatever text it produced, but there is no point
  // spending another model call verifying citations nobody is waiting for.
  if (
    VERIFY_ENABLED &&
    !opts.abortSignal?.aborted &&
    usedRefs.size > 0 &&
    usedCitations.length > 0
  ) {
    opts.onStatus?.({ phase: "verifying" });
    usedCitations = await verifyCitations(
      client,
      result.assistantContent,
      usedCitations,
      chunkById
    );
  }

  return {
    assistantContent: result.assistantContent,
    citations: usedCitations,
    model: result.model,
    tokens: result.tokens,
    retrievedCount: result.chunks.length,
    topScore: result.chunks.length > 0 ? 1 : 0,
    groundedFromContext: result.chunks.length > 0,
    mode: "agent",
    budgetHit: result.budgetHit,
    creditBudget: result.creditBudget,
  };
}
