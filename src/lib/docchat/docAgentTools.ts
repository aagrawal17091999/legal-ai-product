/**
 * Tools for the workspace document agent.
 *
 * The agent replaces the old "stuff the whole corpus into every turn" design.
 * Instead of deciding by corpus size which of full / mapreduce / retrieval to
 * run, the model chooses what to read: search when it needs relevance, scan
 * when it needs completeness, read a section or a whole document when it needs
 * depth.
 *
 * Why a scan tool exists at all — this is the load-bearing idea:
 *
 *   Top-K retrieval is PROBABLE recall. A lexical scan is CERTAIN recall.
 *
 * The eval that motivated this found five case names spread across a 39-chunk
 * order at chunks 5, 16, 17, 26 and 31. A reranked top-8 surfaces some and
 * misses others, and no amount of prompt tuning fixes that — the missing chunks
 * were never in the context. A regex over the same document returns all five
 * for a few hundred tokens. So questions of the form "list every X" and "is X
 * mentioned anywhere" are routed to `scan_documents`, not to search.
 *
 * That also makes an honest "I couldn't find that" possible: the agent may only
 * claim absence after a scan came back empty, which is evidence, where an empty
 * top-K result is merely a failure to retrieve.
 *
 * Every query is HARD-SCOPED to one workspace in SQL (`WHERE workspace_id = $1`),
 * matching retrieve.ts — a tool call can never reach another workspace's chunks.
 */

import type Anthropic from "@anthropic-ai/sdk";
import pool from "../db";
import { logError } from "../error-logger";
import { retrieveWorkspaceChunks, type DocChunkHit } from "./retrieve";

const numEnv = (name: string, fallback: number): number => {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Chunks returned by one search call. Higher than the 8 used by the old
 *  retrieval mode: context is now the only thing we pay for, so breadth here is
 *  cheap relative to what stuffing cost. */
const SEARCH_DEFAULT_LIMIT = numEnv("DOC_AGENT_SEARCH_LIMIT", 15);
const SEARCH_MAX_LIMIT = numEnv("DOC_AGENT_SEARCH_MAX", 30);

/** Matches returned by one scan. A scan is meant to be exhaustive, so this is
 *  generous — but still bounded, because a pathological pattern like "the" would
 *  otherwise pull the entire corpus back in and recreate the problem the agent
 *  exists to solve. */
const SCAN_MAX_MATCHES = numEnv("DOC_AGENT_SCAN_MAX_MATCHES", 60);
/** Characters of context returned either side of each scan match. */
const SCAN_CONTEXT_CHARS = numEnv("DOC_AGENT_SCAN_CONTEXT", 220);

/** Per-call character budgets for the two "read deeply" tools. */
const SECTION_MAX_CHARS = numEnv("DOC_AGENT_SECTION_CHARS", 30_000);
const DOCUMENT_MAX_CHARS = numEnv("DOC_AGENT_DOCUMENT_CHARS", 120_000);

export type DocToolName =
  | "list_documents"
  | "search_documents"
  | "scan_documents"
  | "load_document_section"
  | "read_document";

export interface DocToolCallRecord {
  name: DocToolName;
  input: unknown;
  status: "success" | "error";
  /** Chunks this call surfaced, for the registry and the citation list. */
  chunksReturned: number;
  ms: number;
  error?: string;
}

/**
 * Assigns stable 1-based citation refs to chunks as they surface across tool
 * calls, so `[3]` means the same chunk for the whole turn no matter which tool
 * produced it or how many times it comes back.
 *
 * Ported from the case-law CaseRegistry. The old doc-chat path numbered one
 * fixed chunk list up front, which cannot work once chunks arrive incrementally
 * from several calls — without this, a chunk found by both search and scan
 * would get two different numbers and the answer's citations would drift.
 */
export class ChunkRegistry {
  private byChunkId = new Map<number, number>();
  private chunks: DocChunkHit[] = [];

  /** Register a chunk (idempotent) and return its stable ref. */
  add(chunk: DocChunkHit): number {
    const existing = this.byChunkId.get(chunk.chunk_id);
    if (existing !== undefined) return existing;
    const ref = this.chunks.length + 1;
    this.byChunkId.set(chunk.chunk_id, ref);
    this.chunks.push(chunk);
    return ref;
  }

  addAll(chunks: DocChunkHit[]): number[] {
    return chunks.map((c) => this.add(c));
  }

  /** Every chunk surfaced this turn, in ref order (ref N is at index N-1). */
  all(): DocChunkHit[] {
    return this.chunks;
  }

  get size(): number {
    return this.chunks.length;
  }
}

export interface DocToolContext {
  workspaceId: string;
  registry: ChunkRegistry;
}

// ─────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────

export const DOC_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "list_documents",
    description:
      "List every document in this workspace with its filename, page count and size. " +
      "Cheap orientation — call this first when you do not yet know what the workspace " +
      "contains, or when the question refers to 'the contract' / 'the order' and you need " +
      "to know which document that is.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_documents",
    description:
      "Semantic + keyword search across the workspace, reranked for relevance. Use this " +
      "as your default tool for questions about a specific topic, fact, clause or event. " +
      "Returns the most relevant passages, not all of them — if the question asks for " +
      "EVERY instance of something, or whether something is mentioned AT ALL, use " +
      "scan_documents instead, because search can silently miss matches.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for, phrased as a question or topic.",
        },
        limit: {
          type: "integer",
          description: `How many passages to return (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "scan_documents",
    description:
      "Exhaustively scan EVERY passage in the workspace for a regular expression and " +
      "return all matches with surrounding context, document name and page. This is " +
      "complete where search is only probable, and it is cheap. Use it whenever " +
      "completeness matters:\n" +
      "  - 'list every X' / 'how many X' / 'all the dates on which...'\n" +
      "  - checking whether a topic appears at all before saying it does not\n" +
      "Write a pattern broad enough to catch variants — e.g. 'notice|notices' rather " +
      "than one exact phrase, or '\\\\d{2}\\\\.\\\\d{2}\\\\.\\\\d{4}' for dates. Case-insensitive. " +
      "You may call this several times with different patterns.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "POSIX regular expression, case-insensitive. Alternation with | is supported.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "load_document_section",
    description:
      "Read a contiguous run of passages from one document, in order. Use after search " +
      "or scan when you have found the right place and need what surrounds it — a full " +
      "clause, an argument and its response, the reasoning behind a finding.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "From list_documents or a previous result." },
        from_chunk: { type: "integer", description: "First chunk index (0-based, inclusive)." },
        to_chunk: { type: "integer", description: "Last chunk index (inclusive)." },
      },
      required: ["document_id", "from_chunk", "to_chunk"],
    },
  },
  {
    name: "read_document",
    description:
      "Read one document end to end. Use for questions that genuinely need the whole " +
      "thing — 'summarise this order', 'what are all the parties' positions'. Prefer " +
      "search or scan when the question is about a specific point: this is the most " +
      "expensive tool and reading a whole document to answer a one-line question wastes " +
      "the user's credits.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "From list_documents." },
      },
      required: ["document_id"],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────

/**
 * Header for one passage.
 *
 * The bracketed ref is the ONLY citable number, so nothing else in the header
 * may look like one. An earlier version rendered `[4] (file.pdf, p.12, passage
 * 32)` and the model duly cited `[32]` — a passage index that was never a
 * citation. Hence `passage_index=32`: labelled, keyed, and visibly not a
 * citation, while still available for load_document_section.
 */
function chunkHeader(ref: number, c: DocChunkHit): string {
  const page = c.page_no != null ? ` · p.${c.page_no}` : "";
  return `[${ref}] ${c.document_name}${page} · passage_index=${c.chunk_index}`;
}

/** Render chunks as numbered excerpts using their registry refs. */
function renderChunks(chunks: DocChunkHit[], registry: ChunkRegistry): string {
  if (chunks.length === 0) return "(no passages)";
  return chunks
    .map((c) => `${chunkHeader(registry.add(c), c)}\n${c.chunk_text}`)
    .join("\n\n---\n\n");
}

// ─────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────

async function listDocuments(ctx: DocToolContext): Promise<string> {
  const { rows } = await pool.query(
    `SELECT id, filename, page_count, chunk_count, char_count
       FROM workspace_documents
      WHERE workspace_id = $1 AND status = 'ready'
      ORDER BY created_at`,
    [ctx.workspaceId]
  );
  if (rows.length === 0) return "This workspace has no ready documents.";
  return rows
    .map(
      (r) =>
        `- ${r.filename}\n  document_id: ${r.id}\n  pages: ${r.page_count ?? "?"}, ` +
        `passages: 0..${Math.max(0, Number(r.chunk_count) - 1)}, ` +
        `~${Math.round(Number(r.char_count ?? 0) / 4)} tokens`
    )
    .join("\n");
}

async function searchDocuments(
  ctx: DocToolContext,
  input: { query?: string; limit?: number }
): Promise<{ text: string; chunks: DocChunkHit[] }> {
  const query = String(input.query ?? "").trim();
  if (!query) return { text: "search_documents requires a query.", chunks: [] };
  const limit = Math.min(Math.max(1, input.limit ?? SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT);

  const { chunks, topScore } = await retrieveWorkspaceChunks(ctx.workspaceId, query, limit);
  if (chunks.length === 0) {
    return {
      text:
        "No passages matched that query. Note this does NOT establish that the topic is " +
        "absent — use scan_documents to check that.",
      chunks: [],
    };
  }
  const quality = topScore >= 0.6 ? "strong" : topScore >= 0.45 ? "moderate" : "weak";
  return {
    text: `${chunks.length} passage(s), relevance ${quality}:\n\n${renderChunks(chunks, ctx.registry)}`,
    chunks,
  };
}

/**
 * Exhaustive lexical scan. Runs the regex in Postgres against every chunk in the
 * workspace so recall is a property of the query, not of an embedding model.
 *
 * The pattern comes from the model, so it is untrusted input to the regex
 * engine: an invalid or catastrophic pattern must surface as a tool error the
 * agent can recover from, never as a 500. `statement_timeout` bounds runaway
 * backtracking; a syntax error is caught and returned as guidance.
 */
async function scanDocuments(
  ctx: DocToolContext,
  input: { pattern?: string }
): Promise<{ text: string; chunks: DocChunkHit[] }> {
  const pattern = String(input.pattern ?? "").trim();
  if (!pattern) return { text: "scan_documents requires a pattern.", chunks: [] };

  const client = await pool.connect();
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    const { rows } = await client.query(
      `SELECT dc.id AS chunk_id, dc.document_id, wd.filename AS document_name,
              dc.page_no, dc.chunk_index, dc.chunk_text,
              (regexp_matches(dc.chunk_text, $2, 'gi'))[1] AS hit
         FROM document_chunks dc
         JOIN workspace_documents wd ON wd.id = dc.document_id
        WHERE dc.workspace_id = $1
          AND dc.chunk_text ~* $2
        ORDER BY wd.filename, dc.chunk_index
        LIMIT $3`,
      [ctx.workspaceId, `(${pattern})`, SCAN_MAX_MATCHES]
    );

    if (rows.length === 0) {
      return {
        text:
          `No passage in this workspace matches /${pattern}/i. This IS evidence of ` +
          `absence — the whole workspace was searched, not a sample.`,
        chunks: [],
      };
    }

    // Group by chunk so a chunk matching several times is registered once, and
    // return a context window around each match rather than the whole passage:
    // the point of a scan is breadth of coverage at low token cost.
    const byChunk = new Map<number, { chunk: DocChunkHit; hits: string[] }>();
    for (const r of rows) {
      const chunk: DocChunkHit = {
        chunk_id: r.chunk_id,
        document_id: r.document_id,
        document_name: r.document_name,
        page_no: r.page_no,
        chunk_index: r.chunk_index,
        chunk_text: r.chunk_text,
        rrf_score: 0,
        rerank_score: 0,
      };
      const entry = byChunk.get(r.chunk_id) ?? { chunk, hits: [] };
      if (r.hit) entry.hits.push(String(r.hit));
      byChunk.set(r.chunk_id, entry);
    }

    const parts: string[] = [];
    const chunks: DocChunkHit[] = [];
    for (const { chunk, hits } of byChunk.values()) {
      const ref = ctx.registry.add(chunk);
      chunks.push(chunk);
      const windows = [...new Set(hits)].slice(0, 4).map((hit) => {
        const at = chunk.chunk_text.toLowerCase().indexOf(hit.toLowerCase());
        if (at < 0) return hit;
        const from = Math.max(0, at - SCAN_CONTEXT_CHARS);
        const to = Math.min(chunk.chunk_text.length, at + hit.length + SCAN_CONTEXT_CHARS);
        return `...${chunk.chunk_text.slice(from, to).replace(/\s+/g, " ").trim()}...`;
      });
      parts.push(`${chunkHeader(ref, chunk)}\n${windows.join("\n")}`);
    }

    const capped =
      rows.length >= SCAN_MAX_MATCHES
        ? `\n\n(capped at ${SCAN_MAX_MATCHES} matches — narrow the pattern for full coverage)`
        : "";
    return {
      text: `${byChunk.size} passage(s) match /${pattern}/i:\n\n${parts.join("\n\n")}${capped}`,
      chunks,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Invalid regex is a model error, not a system fault — hand it back so the
    // agent can retry with a corrected pattern.
    if (/invalid regular expression|statement timeout|canceling statement/i.test(msg)) {
      return {
        text:
          `That pattern could not be run (${msg}). Simplify it — plain alternation like ` +
          `'notice|notices' is usually enough.`,
        chunks: [],
      };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function loadDocumentSection(
  ctx: DocToolContext,
  input: { document_id?: string; from_chunk?: number; to_chunk?: number }
): Promise<{ text: string; chunks: DocChunkHit[] }> {
  const documentId = String(input.document_id ?? "").trim();
  if (!documentId) return { text: "load_document_section requires a document_id.", chunks: [] };
  const from = Math.max(0, Number(input.from_chunk ?? 0));
  const to = Math.max(from, Number(input.to_chunk ?? from));

  const { rows } = await pool.query(
    `SELECT dc.id AS chunk_id, dc.document_id, wd.filename AS document_name,
            dc.page_no, dc.chunk_index, dc.chunk_text
       FROM document_chunks dc
       JOIN workspace_documents wd ON wd.id = dc.document_id
      WHERE dc.workspace_id = $1 AND dc.document_id = $2
        AND dc.chunk_index BETWEEN $3 AND $4
      ORDER BY dc.chunk_index`,
    [ctx.workspaceId, documentId, from, to]
  );
  if (rows.length === 0) {
    return { text: `No passages ${from}..${to} in that document.`, chunks: [] };
  }
  return capAndRender(rows as DocChunkHit[], ctx.registry, SECTION_MAX_CHARS);
}

async function readDocument(
  ctx: DocToolContext,
  input: { document_id?: string }
): Promise<{ text: string; chunks: DocChunkHit[] }> {
  const documentId = String(input.document_id ?? "").trim();
  if (!documentId) return { text: "read_document requires a document_id.", chunks: [] };

  const { rows } = await pool.query(
    `SELECT dc.id AS chunk_id, dc.document_id, wd.filename AS document_name,
            dc.page_no, dc.chunk_index, dc.chunk_text
       FROM document_chunks dc
       JOIN workspace_documents wd ON wd.id = dc.document_id
      WHERE dc.workspace_id = $1 AND dc.document_id = $2
      ORDER BY dc.chunk_index`,
    [ctx.workspaceId, documentId]
  );
  if (rows.length === 0) return { text: "That document has no indexed text.", chunks: [] };
  return capAndRender(rows as DocChunkHit[], ctx.registry, DOCUMENT_MAX_CHARS);
}

/** Register + render chunks up to a character budget, telling the model exactly
 *  where it was cut so it can ask for the rest rather than assume it has all. */
function capAndRender(
  rows: DocChunkHit[],
  registry: ChunkRegistry,
  maxChars: number
): { text: string; chunks: DocChunkHit[] } {
  const kept: DocChunkHit[] = [];
  let used = 0;
  for (const r of rows) {
    if (used + r.chunk_text.length > maxChars && kept.length > 0) break;
    kept.push({ ...r, rrf_score: 0, rerank_score: 0 });
    used += r.chunk_text.length;
  }
  const truncated =
    kept.length < rows.length
      ? `\n\n(truncated at passage ${kept[kept.length - 1].chunk_index} of ` +
        `${rows[rows.length - 1].chunk_index} — call load_document_section for the rest)`
      : "";
  return { text: renderChunks(kept, registry) + truncated, chunks: kept };
}

// ─────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────

/**
 * Execute one tool call. Tool-level failures are returned as text for the model
 * to react to rather than thrown: an agent that can read the error usually
 * recovers on the next step, whereas a throw ends the turn.
 */
export async function executeDocTool(
  ctx: DocToolContext,
  name: string,
  input: unknown
): Promise<{ text: string; record: DocToolCallRecord }> {
  const startedAt = Date.now();
  const args = (input ?? {}) as Record<string, never>;
  let text: string;
  let chunks: DocChunkHit[] = [];

  try {
    switch (name) {
      case "list_documents":
        text = await listDocuments(ctx);
        break;
      case "search_documents": {
        const r = await searchDocuments(ctx, args);
        text = r.text;
        chunks = r.chunks;
        break;
      }
      case "scan_documents": {
        const r = await scanDocuments(ctx, args);
        text = r.text;
        chunks = r.chunks;
        break;
      }
      case "load_document_section": {
        const r = await loadDocumentSection(ctx, args);
        text = r.text;
        chunks = r.chunks;
        break;
      }
      case "read_document": {
        const r = await readDocument(ctx, args);
        text = r.text;
        chunks = r.chunks;
        break;
      }
      default:
        text = `Unknown tool "${name}".`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError({
      category: "search",
      message,
      error: err,
      severity: "error",
      metadata: { feature: "docagent_tool", tool: name, workspaceId: ctx.workspaceId },
    });
    return {
      text: `Tool ${name} failed: ${message}. Try a different approach.`,
      record: {
        name: name as DocToolName,
        input,
        status: "error",
        chunksReturned: 0,
        ms: Date.now() - startedAt,
        error: message,
      },
    };
  }

  return {
    text,
    record: {
      name: name as DocToolName,
      input,
      status: "success",
      chunksReturned: chunks.length,
      ms: Date.now() - startedAt,
    },
  };
}
