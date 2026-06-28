/**
 * Document-workspace chat (Feature 1).
 *
 * Pipeline: understand the question → pick a grounding strategy by document size
 * and question type → answer only from the documents → verify the citations.
 *
 * Grounding strategies (chosen automatically):
 *   - full        : the whole corpus fits in one context window → pass all of it.
 *                   Best for small/medium documents; nothing is missed.
 *   - map-reduce  : corpus too big for one pass AND the question is an
 *                   aggregation/enumeration ("list every X", "what laws are
 *                   cited", "summarise") → read the document in large blocks in
 *                   parallel, extract every relevant passage, then synthesise.
 *                   This is what makes comprehensive answers actually complete;
 *                   top-K retrieval structurally cannot enumerate across 200pp.
 *   - retrieval   : corpus too big and the question is a pinpoint lookup →
 *                   conversation-aware hybrid retrieval of the best passages.
 *
 * Citations always carry the chunk_id, so the source panel can show the real,
 * cleaned document text and the grounding pass can flag anything unsupported.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../claude";
import { cachedSystem } from "../rag/promptCache";
import {
  retrieveWorkspaceChunks,
  getWorkspaceCorpusSize,
  getAllWorkspaceChunks,
  type DocChunkHit,
} from "./retrieve";
import { logError } from "../error-logger";

const CHAT_MODEL = process.env.CHAT_MODEL?.trim() || "claude-sonnet-4-6";
// Cheap models for the auxiliary understand/map/verify calls.
const FAST_MODEL = process.env.DOC_FAST_MODEL?.trim() || "claude-haiku-4-5";
const MAX_TOKENS = 8192; // allow long enumerations ("list every citation")
const HISTORY_TURNS = 10;

const CHARS_PER_TOKEN = 4;
// If the cleaned corpus fits this budget, answer from the whole thing in one
// pass. ~120k tokens leaves room for history + a long answer inside a 200k
// window. Override with DOC_SINGLE_PASS_TOKENS.
const SINGLE_PASS_TOKENS = Number(process.env.DOC_SINGLE_PASS_TOKENS) || 120_000;
const SINGLE_PASS_CHARS = SINGLE_PASS_TOKENS * CHARS_PER_TOKEN;
// Block size for the map step when the corpus is larger than one pass.
const MAP_BLOCK_CHARS = Number(process.env.DOC_MAP_BLOCK_CHARS) || 80_000;
const VERIFY_ENABLED = (process.env.DOC_VERIFY ?? "on").trim().toLowerCase() !== "off";

export const DOC_SYSTEM_PROMPT = `You are a careful legal document assistant. You answer questions about a specific set of documents a user has uploaded to this workspace.

ABSOLUTE RULES — these override everything else:
1. Answer ONLY from the numbered document excerpts provided in the user's message under "DOCUMENT EXCERPTS". Treat them as your sole source of truth.
2. Do NOT use general knowledge, outside law, or anything not present in those excerpts. You are not a general legal advisor here; you are a reader of these specific documents.
3. If the excerpts do not contain enough to answer, say exactly: "I couldn't find that in your uploaded documents." Then, if useful, state briefly what the documents DO cover. Never guess or fill gaps from training data.
4. Cite every factual statement with a bracketed source number matching the excerpt it came from, e.g. [1] or [2][3]. Put the citation at the end of the sentence or clause it supports.
5. Quote or closely paraphrase the documents. Do not introduce facts, figures, dates, names, or legal conclusions that are not in the excerpts.
6. If the question asks for ALL of something (every law/citation/party/date/relief), be exhaustive: list each distinct item you find in the excerpts, deduplicated, rather than a representative sample.
7. Ignore page headers, footers, watermarks, signature stamps and publisher notices; never treat them as substantive content to cite.
8. If excerpts conflict, surface the conflict and cite both rather than resolving it silently.

Be precise and concise. A lawyer is reading this to verify against the source, so accuracy and traceability matter more than fluency.`;

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

export type DocChatPhase = "analyzing" | "retrieving" | "reading" | "verifying";

export interface DocChatRunOptions {
  workspaceId: string;
  userMessage: string;
  history: DocChatTurn[];
  onTextDelta: (delta: string) => void;
  onStatus?: (status: { phase: DocChatPhase }) => void;
}

export interface DocChatResult {
  assistantContent: string;
  citations: DocCitation[];
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  retrievedCount: number;
  topScore: number;
  groundedFromContext: boolean;
  mode: "full" | "mapreduce" | "retrieval";
}

/** Build the numbered citation list for a set of chunks (refs are 1-based). */
function buildCitations(chunks: DocChunkHit[]): DocCitation[] {
  return chunks.map((c, i) => ({
    ref: i + 1,
    chunk_id: c.chunk_id,
    document_id: c.document_id,
    document_name: c.document_name,
    page_no: c.page_no,
    snippet: c.chunk_text.slice(0, 320),
  }));
}

/** Render chunks as numbered excerpts; `offset` keeps refs globally stable across map blocks. */
function renderExcerpts(chunks: DocChunkHit[], offset = 0): string {
  return chunks
    .map((c, i) => {
      const page = c.page_no != null ? `, p.${c.page_no}` : "";
      return `[${offset + i + 1}] (Document: ${c.document_name}${page})\n${c.chunk_text}`;
    })
    .join("\n\n---\n\n");
}

interface QueryAnalysis {
  query: string;
  intent: "lookup" | "aggregate";
}

/**
 * Understand the question before answering: resolve follow-up references into a
 * standalone search query, and classify whether it's a pinpoint LOOKUP or an
 * AGGREGATE/enumeration question. Best-effort — defaults to the raw message as a
 * lookup if the call fails, so it can never block the answer.
 */
async function analyzeQuery(
  client: Anthropic,
  history: DocChatTurn[],
  userMessage: string
): Promise<QueryAnalysis> {
  const recent = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
  try {
    const msg = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 300,
      system:
        'You prepare a user question for a document-search system. Resolve pronouns/references using the conversation into a single standalone search query. Also classify intent: "aggregate" if the question asks to enumerate, list, count, summarise, or cover ALL of something (e.g. "what laws are cited", "list every relief", "summarise the affidavit"); otherwise "lookup" for a specific fact. Respond with ONLY JSON: {"query":"...","intent":"lookup"|"aggregate"}.',
      messages: [
        {
          role: "user",
          content: recent
            ? `Conversation so far:\n${recent}\n\nLatest message: ${userMessage}`
            : `Question: ${userMessage}`,
        },
      ],
    });
    const raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s !== -1 && e !== -1) {
      const parsed = JSON.parse(raw.slice(s, e + 1)) as Partial<QueryAnalysis>;
      return {
        query: parsed.query?.trim() || userMessage,
        intent: parsed.intent === "aggregate" ? "aggregate" : "lookup",
      };
    }
  } catch {
    /* fall through */
  }
  return { query: userMessage, intent: "lookup" };
}

/** Split chunks into contiguous blocks bounded by char size, tracking each block's ref offset. */
function splitBlocks(chunks: DocChunkHit[]): Array<{ chunks: DocChunkHit[]; offset: number }> {
  const blocks: Array<{ chunks: DocChunkHit[]; offset: number }> = [];
  let cur: DocChunkHit[] = [];
  let curLen = 0;
  let offset = 0;
  for (const c of chunks) {
    if (cur.length > 0 && curLen + c.chunk_text.length > MAP_BLOCK_CHARS) {
      blocks.push({ chunks: cur, offset });
      offset += cur.length;
      cur = [];
      curLen = 0;
    }
    cur.push(c);
    curLen += c.chunk_text.length;
  }
  if (cur.length > 0) blocks.push({ chunks: cur, offset });
  return blocks;
}

/**
 * MAP step: pull every passage relevant to the question out of one block,
 * preserving the global [ref] markers so the reduce step (and the citation
 * panel) can resolve them. Returns "" when nothing in the block is relevant.
 */
async function mapBlock(
  client: Anthropic,
  question: string,
  block: { chunks: DocChunkHit[]; offset: number }
): Promise<string> {
  try {
    const msg = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 2048,
      system:
        'You are extracting source material to answer a question, from ONE part of a larger legal document. From the numbered excerpts, copy EVERY passage relevant to the question — verbatim or closely — and keep each excerpt\'s bracketed [number] so it can be cited. Be exhaustive within this part; do not summarise away specifics. Ignore page headers, footers, watermarks and publisher notices. If nothing here is relevant, reply with exactly: NONE.',
      messages: [
        {
          role: "user",
          content: `QUESTION:\n${question}\n\nEXCERPTS:\n${renderExcerpts(block.chunks, block.offset)}`,
        },
      ],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return /^NONE\b/i.test(text) ? "" : text;
  } catch {
    return "";
  }
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

/** Stream one grounded answer from a prepared context block. */
async function streamAnswer(
  client: Anthropic,
  history: DocChatTurn[],
  userTurn: string,
  onTextDelta: (delta: string) => void
): Promise<{
  content: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}> {
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userTurn },
  ];
  let content = "";
  const stream = client.messages.stream({
    model: CHAT_MODEL,
    max_tokens: MAX_TOKENS,
    system: cachedSystem(DOC_SYSTEM_PROMPT),
    messages,
  });
  stream.on("text", (delta) => {
    content += delta;
    onTextDelta(delta);
  });
  const finalMsg = await stream.finalMessage();
  if (!content) {
    content = finalMsg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  return {
    content,
    model: finalMsg.model,
    input: finalMsg.usage.input_tokens,
    output: finalMsg.usage.output_tokens,
    cacheRead: finalMsg.usage.cache_read_input_tokens ?? 0,
    cacheWrite: finalMsg.usage.cache_creation_input_tokens ?? 0,
  };
}

export async function runDocChat(opts: DocChatRunOptions): Promise<DocChatResult> {
  const client = getAnthropicClient();

  // 1. Understand the question.
  opts.onStatus?.({ phase: "analyzing" });
  const { query, intent } = await analyzeQuery(client, opts.history, opts.userMessage);

  // 2. Choose a grounding strategy by corpus size and question type.
  const corpusChars = await getWorkspaceCorpusSize(opts.workspaceId);
  const fitsOnePass = corpusChars > 0 && corpusChars <= SINGLE_PASS_CHARS;

  let chunks: DocChunkHit[];
  let topScore: number;
  let mode: DocChatResult["mode"];

  if (fitsOnePass) {
    mode = "full";
    opts.onStatus?.({ phase: "reading" });
    chunks = await getAllWorkspaceChunks(opts.workspaceId);
    topScore = 1;
  } else if (intent === "aggregate") {
    mode = "mapreduce";
    chunks = await getAllWorkspaceChunks(opts.workspaceId);
    topScore = 1;
  } else {
    mode = "retrieval";
    opts.onStatus?.({ phase: "retrieving" });
    const res = await retrieveWorkspaceChunks(opts.workspaceId, query);
    chunks = res.chunks;
    topScore = res.topScore;
  }

  const chunkById = new Map(chunks.map((c) => [c.chunk_id, c]));
  const citations = buildCitations(chunks);

  // 3. Build the context the answer is grounded on.
  let contextText: string;
  if (mode === "mapreduce") {
    opts.onStatus?.({ phase: "reading" });
    const blocks = splitBlocks(chunks);
    const findings = await Promise.all(blocks.map((b) => mapBlock(client, query, b)));
    contextText = findings.filter(Boolean).join("\n\n");
  } else {
    contextText = renderExcerpts(chunks);
  }

  const userTurn =
    contextText.trim().length > 0
      ? `DOCUMENT EXCERPTS (your only source — cite by the bracketed number):\n\n${contextText}\n\n----\n\nQUESTION:\n${opts.userMessage}`
      : `DOCUMENT EXCERPTS: (none matched this query in the uploaded documents)\n\nQUESTION:\n${opts.userMessage}\n\nIf there are no excerpts, tell the user you couldn't find this in their uploaded documents.`;

  // 4. Answer (streaming).
  let result;
  try {
    result = await streamAnswer(client, opts.history, userTurn, opts.onTextDelta);
  } catch (err) {
    logError({
      category: "chat",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      metadata: { feature: "docchat", workspaceId: opts.workspaceId, mode },
    });
    throw err;
  }
  const assistantContent = result.content;

  // 5. Keep only the citations the model actually referenced.
  const usedRefs = new Set<number>();
  for (const m of assistantContent.matchAll(/\[(\d+)\]/g)) usedRefs.add(parseInt(m[1], 10));
  let usedCitations =
    usedRefs.size > 0 ? citations.filter((c) => usedRefs.has(c.ref)) : citations;

  // 6. Grounding pass.
  if (VERIFY_ENABLED && usedRefs.size > 0 && usedCitations.length > 0) {
    opts.onStatus?.({ phase: "verifying" });
    usedCitations = await verifyCitations(client, assistantContent, usedCitations, chunkById);
  }

  return {
    assistantContent,
    citations: usedCitations,
    model: result.model,
    tokens: {
      input: result.input,
      output: result.output,
      cacheRead: result.cacheRead,
      cacheWrite: result.cacheWrite,
    },
    retrievedCount: chunks.length,
    topScore,
    groundedFromContext: chunks.length > 0,
    mode,
  };
}
