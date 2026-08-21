import type Anthropic from "@anthropic-ai/sdk";
import {
  retrieveChunks,
  lookupByIdentifier,
  resolveIdentifiers,
  type RetrievedChunk,
  type IdentifierSpec,
} from "../search";
import { rerank } from "../voyage";
import { expandQueries } from "./queryExpansion";
import { buildContext, type AssembledCase } from "./contextBuilder";
import {
  queryAllChunksForCases,
  queryCitedCases,
  type SessionDocumentStore,
} from "./sessionStore";
import { logError } from "../error-logger";
import type { SearchFilters, CitedCase } from "@/types";

/**
 * Tool layer for the agentic retrieval pipeline.
 *
 * Unlike the old linear pipeline (router → retrieve → rerank → generate), the
 * agent decides *at generation time* what to pull and composes its own answer
 * context via tool calls. This file defines:
 *
 *   - TOOL_DEFINITIONS : the Anthropic.Tool[] handed to the model
 *   - executeTool      : the dispatcher the agent loop calls per tool_use block
 *   - CaseRegistry     : stable `[^n]` index assignment across multi-tool turns
 *
 * Tool results are plain strings (formatted case blocks or JSON). They flow
 * back to the model as `tool_result` content blocks inside the conversation.
 */

function qualityLabel(score: number): string {
  if (score >= 0.6) return "strong";
  if (score >= 0.45) return "moderate";
  return "weak";
}

const numEnv = (name: string, fallback: number): number => {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// #4 Read more, chunk less. load_case is the "read this judgment deeply" path,
// so it pulls more chunks and gets a much larger per-case char budget than the
// breadth-oriented search_fresh. Prompt caching keeps re-reading this cheap.
const LOAD_CASE_MAX_CHUNKS = numEnv("LOAD_CASE_MAX_CHUNKS", 60);
const LOAD_CASE_PER_CASE_CHARS = numEnv("LOAD_CASE_PER_CASE_CHARS", 28_000);
/**
 * Total load_case text admitted in ONE agent round, shared across however many
 * load_case calls the model issues in parallel.
 *
 * LOAD_CASE_PER_CASE_CHARS is applied per *invocation*, so it never bounded a
 * batch: a "summarise all of these" follow-up fanned out to 7 parallel
 * load_case calls and admitted 7 x 28,000 chars (~49k tokens) in a single
 * round. Measured on one such turn that was 61% of a 44-credit question — for
 * an answer that then truncated at max_tokens anyway. A round-level budget
 * makes a 7-case request trade depth-per-case for breadth, which is what the
 * request actually asks for; a 1-case deep read is unaffected (the share is
 * clamped back up to the per-case cap).
 */
const LOAD_CASE_ROUND_CHARS = numEnv("LOAD_CASE_ROUND_CHARS", 60_000);
/**
 * Floor on a single case's share, whatever the batch size. A case the user
 * explicitly asked about must never be reduced to a stub, so this deliberately
 * wins over LOAD_CASE_ROUND_CHARS: 12 parallel calls overshoot the round budget
 * rather than render 12 unusable excerpts.
 */
const LOAD_CASE_MIN_CHARS = numEnv("LOAD_CASE_MIN_CHARS", 6_000);
const LOAD_CASE_RERANK_POOL = 80;
const SEARCH_FRESH_POOL = 40;
const SEARCH_FRESH_DEFAULT_LIMIT = 10;
const SEARCH_FRESH_MAX_LIMIT = 20;

// Minimum cross-encoder relevance score (Voyage rerank-2 returns [0,1]) for a
// chunk to be treated as an on-point result. Chunks below this are dropped; if
// NONE clear the bar, search_fresh abstains ("no directly relevant case")
// instead of presenting the reranker's least-bad guesses as authority. Tunable
// via SEARCH_RELEVANCE_FLOOR — raise for stricter precision, lower for recall.
const SEARCH_RELEVANCE_FLOOR = (() => {
  const v = parseFloat(process.env.SEARCH_RELEVANCE_FLOOR ?? "");
  return Number.isFinite(v) ? v : 0.3;
})();

// ─────────────────────────────────────────────────────────────
// CaseRegistry — assigns stable 1-based indices to cases as they are
// surfaced by tool calls during one turn. A case surfaced twice (e.g. by
// list_session_cases then load_case) keeps the same `[^n]` index so the
// model's citation markers stay unambiguous.
// ─────────────────────────────────────────────────────────────

export class CaseRegistry {
  private byKey = new Map<string, AssembledCase>();
  private order: AssembledCase[] = [];

  upsert(c: AssembledCase): AssembledCase {
    const key = `${c.source_table}:${c.source_id}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const withIdx: AssembledCase = { ...c, index: this.order.length + 1 };
    this.byKey.set(key, withIdx);
    this.order.push(withIdx);
    return withIdx;
  }

  list(): AssembledCase[] {
    return [...this.order];
  }

  toCitedCases(): CitedCase[] {
    return this.order.map((c) => ({
      id: c.source_id,
      source_table: c.source_table,
      title: c.meta.title,
      citation: c.extraction.extracted_citation ?? c.meta.citation,
      pdf_url: c.pdf_url,
      pdf_path: c.pdf_path,
      // The canonical [^n] index for this case, so the UI resolves citations by
      // index rather than fragile array position.
      index: c.index,
      // Paragraphs visible in this case's excerpt — the ones the model is
      // allowed to pinpoint — so the UI can offer paragraph-level entry points.
      paragraphs: c.chunk_paragraphs ?? [],
    }));
  }
}

// ─────────────────────────────────────────────────────────────
// Per-tool-call audit record. The agent loop appends one per invocation to
// ToolContext.trace; the route handler serializes them as rag_pipeline_steps
// rows with step='tool_call'.
// ─────────────────────────────────────────────────────────────

export type ToolName =
  | "list_session_cases"
  | "load_case"
  | "search_fresh"
  | "lookup_by_citation"
  | "expand_cited_cases";

export interface ToolCallRecord {
  tool: ToolName;
  input: Record<string, unknown>;
  started_at: string;
  duration_ms: number;
  status: "success" | "error";
  error: string | null;
  data: Record<string, unknown>;
  /** First 500 chars of the tool result, for the audit log. */
  result_preview: string;
}

/**
 * A single load_case call's char budget, given how many load_case calls share
 * this round. One call gets the full per-case cap (unchanged behaviour); a
 * batch splits the round budget, never dropping below LOAD_CASE_MIN_CHARS.
 */
export function loadCaseCharBudget(siblingLoadCases: number): number {
  const n = Math.max(1, siblingLoadCases);
  const share = Math.floor(LOAD_CASE_ROUND_CHARS / n);
  return Math.min(LOAD_CASE_PER_CASE_CHARS, Math.max(LOAD_CASE_MIN_CHARS, share));
}

export interface ToolContext {
  sessionStore: SessionDocumentStore;
  sessionFilters: SearchFilters;
  registry: CaseRegistry;
  trace: ToolCallRecord[];
  /**
   * Chunk ids already sent to the model this turn.
   *
   * The dominant agent flow is search_fresh → spot a promising case →
   * load_case on it, and load_case used to re-render every chunk search_fresh
   * had already returned for that case. Measured across the 13-question golden
   * set, 803k of 5,224k characters (15%) were text the model had already been
   * given — re-billed at the 1.25x prompt-cache write rate, and on individual
   * questions as much as 53%.
   *
   * Suppressing a repeat is quality-neutral by construction: the passage is
   * still in the model's context from the earlier call, and it is told where
   * (`[^n]`), so nothing it could reason from is removed.
   */
  emittedChunkIds: Set<number>;
}

// ─────────────────────────────────────────────────────────────
// Tool definitions — schemas handed to the Anthropic SDK.
// ─────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "list_session_cases",
    description:
      "Returns every case already cited in this chat session, in recency order, each with its issue/subject/acts. Use this FIRST whenever the user refers to a prior case by pronoun or role noun ('this judgment', 'the respondent', 'the bench', 'that case'), AND whenever a follow-up refines an earlier question — the issue/subject fields let you tell whether a loaded case already covers it (use load_case) before reaching for search_fresh.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "load_case",
    description:
      "Loads the full text of a specific case by (source_table, source_id) as surfaced by list_session_cases or lookup_by_citation. Use when you need the complete judgment OR when the user asks about a particular aspect (arguments, facts, reasoning, dissent, disposal, issues, reliefs) of an already-identified case. Pass `aspect` to rerank the case's chunks around that aspect so the most relevant paragraphs appear first.",
    input_schema: {
      type: "object",
      properties: {
        source_table: {
          type: "string",
          enum: ["supreme_court_cases", "high_court_cases"],
        },
        source_id: {
          type: "integer",
          description: "The case ID within the table.",
        },
        aspect: {
          type: "string",
          description:
            "Optional narrowing phrase to rerank chunks against (e.g. 'arguments of respondent', 'facts of the case', 'dissenting opinion'). Leave empty to load chunks in document order.",
        },
      },
      required: ["source_table", "source_id"],
    },
  },
  {
    name: "search_fresh",
    description:
      "Searches the full Indian SC + HC database for cases relevant to a legal topic. Use when the user asks a fresh legal question ('cases on arrest under Article 22', 'Delhi HC on anticipatory bail') that the session store does not cover. Do NOT use when the user is narrowing into an already-loaded case — prefer load_case for that, since search_fresh surfaces unrelated cases that happen to share legal vocabulary.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A self-contained search query. Resolve pronouns and context-dependent references from the conversation before calling.",
        },
        filters: {
          type: "object",
          description: "Optional filters. Any filter the user set in the UI session takes precedence over these.",
          properties: {
            court: { type: "string" },
            yearFrom: { type: "integer" },
            yearTo: { type: "integer" },
            actCited: { type: "string" },
            judgeName: { type: "string" },
            keyword: { type: "string" },
          },
        },
        limit: {
          type: "integer",
          description: "Max cases to return. Defaults to 10. Keep small when possible.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_by_citation",
    description:
      "Resolves a specific case by citation string or title to a concrete (source_table, source_id). Use when the user names a case that is NOT in list_session_cases output. The returned IDs can then be passed to load_case for full text.",
    input_schema: {
      type: "object",
      properties: {
        citation: {
          type: "string",
          description: "Full citation string if known (e.g. '(2024) 8 SCC 207', '2024 INSC 578').",
        },
        title: {
          type: "string",
          description: "Case title or shorthand (e.g. 'Sisodia', 'Puttaswamy') if citation is not known.",
        },
      },
    },
  },
  {
    name: "expand_cited_cases",
    description:
      "Given a case already loaded (by source_table + source_id), returns the authorities THAT case cites which also exist in our database, each with its (source_table, source_id). Use this to follow the citation graph: when a loaded judgment relies on a specific precedent for the proposition the user needs, call expand_cited_cases, then load_case the relevant authority to read and cite it directly. Only cases present in our DB are returned.",
    input_schema: {
      type: "object",
      properties: {
        source_table: {
          type: "string",
          enum: ["supreme_court_cases", "high_court_cases"],
        },
        source_id: {
          type: "integer",
          description: "The case ID whose cited authorities you want to resolve.",
        },
      },
      required: ["source_table", "source_id"],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Dispatcher — called by agent.ts for each tool_use block.
// Always resolves to a string (never throws); errors are returned as JSON so
// the model can see them and decide how to proceed.
// ─────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  /** How many load_case calls share this round; they split the round budget. */
  opts: { siblingLoadCases?: number } = {}
): Promise<string> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let status: "success" | "error" = "success";
  let error: string | null = null;
  let result = "";
  let auditData: Record<string, unknown> = {};

  try {
    switch (name) {
      case "list_session_cases": {
        const out = executeListSessionCases(ctx);
        result = out.text;
        auditData = out.audit;
        break;
      }
      case "load_case": {
        const out = await executeLoadCase(
          ctx,
          input as unknown as LoadCaseInput,
          loadCaseCharBudget(opts.siblingLoadCases ?? 1)
        );
        result = out.text;
        auditData = out.audit;
        break;
      }
      case "search_fresh": {
        const out = await executeSearchFresh(ctx, input as unknown as SearchFreshInput);
        result = out.text;
        auditData = out.audit;
        break;
      }
      case "lookup_by_citation": {
        const out = await executeLookupByCitation(ctx, input as unknown as LookupByCitationInput);
        result = out.text;
        auditData = out.audit;
        break;
      }
      case "expand_cited_cases": {
        const out = await executeExpandCitedCases(input as unknown as ExpandCitedCasesInput);
        result = out.text;
        auditData = out.audit;
        break;
      }
      default:
        status = "error";
        error = `unknown tool: ${name}`;
        result = JSON.stringify({ error });
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    result = JSON.stringify({ error });
    logError({
      category: "chat",
      message: `agent tool ${name} failed: ${error}`,
      error: err,
      severity: "warning",
      metadata: { tool: name, input },
    });
  }

  ctx.trace.push({
    tool: (name as ToolName) ?? "list_session_cases",
    input,
    started_at: startedAt,
    duration_ms: Date.now() - started,
    status,
    error,
    data: auditData,
    result_preview: result.slice(0, 500),
  });

  return result;
}

// ─────────────────────────────────────────────────────────────
// Tool 1: list_session_cases
// ─────────────────────────────────────────────────────────────

function executeListSessionCases(
  ctx: ToolContext
): { text: string; audit: Record<string, unknown> } {
  const cases = ctx.sessionStore.caseSummaries.map((s) => ({
    recency_rank: s.recency_rank,
    source_table: s.source_table,
    source_id: s.source_id,
    title: s.title,
    citation: s.citation,
    // Content signals so the agent can decide whether this case already covers
    // the user's follow-up (→ load_case) or it needs a fresh search.
    issue: s.issue,
    headnotes_snippet: s.headnotes_snippet,
    acts_cited: s.acts_cited,
  }));
  const text =
    cases.length === 0
      ? JSON.stringify({ cases: [], note: "No cases cited in this session yet." }, null, 2)
      : JSON.stringify(
          {
            cases,
            note: "If one of these cases already covers the user's question, call load_case on it (optionally with an aspect) instead of search_fresh.",
          },
          null,
          2
        );
  return { text, audit: { case_count: cases.length } };
}

// ─────────────────────────────────────────────────────────────
// Tool 2: load_case
// ─────────────────────────────────────────────────────────────

interface LoadCaseInput {
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  aspect?: string;
}

async function executeLoadCase(
  ctx: ToolContext,
  input: LoadCaseInput,
  charBudget: number = LOAD_CASE_PER_CASE_CHARS
): Promise<{ text: string; audit: Record<string, unknown> }> {
  if (!input.source_table || typeof input.source_id !== "number") {
    throw new Error("source_table and source_id are required");
  }

  const allChunks = await queryAllChunksForCases([
    { source_table: input.source_table, source_id: input.source_id },
  ]);
  if (allChunks.length === 0) {
    return {
      text: JSON.stringify({
        error: "case_not_found",
        source_table: input.source_table,
        source_id: input.source_id,
      }),
      audit: {
        source_table: input.source_table,
        source_id: input.source_id,
        chunks: 0,
      },
    };
  }

  let selected: RetrievedChunk[];
  let reranked = false;
  let rerankScores: Array<{ chunk_id: number; score: number }> | undefined;

  if (input.aspect && input.aspect.trim().length > 0) {
    reranked = true;
    const pool = allChunks.slice(0, LOAD_CASE_RERANK_POOL);
    const { results } = await rerank(
      input.aspect,
      pool.map((c) => c.chunk_text),
      LOAD_CASE_MAX_CHUNKS
    );
    rerankScores = results.map((r) => ({
      chunk_id: pool[r.index].chunk_id,
      score: r.score,
    }));

    // Trim to the char budget by RELEVANCE, then restore document order.
    //
    // mergeChunks() fills its budget walking chunks in chunk_index order, so
    // handing it an over-budget set keeps the OPENING of the judgment and
    // silently discards the end — which in a judgment is usually where the
    // holding and the ratio sit. Deciding which paragraphs survive by rerank
    // score first means a tighter budget drops the least on-point paragraphs
    // wherever they fall, rather than lopping off the conclusion.
    //
    // Deliberately not a relevance FLOOR: load_case operates on a case the user
    // has already chosen, so "is this case relevant" is settled. On the turn
    // that prompted this, every chunk of 2 of the 7 cases scored below
    // search_fresh's 0.3 floor — applying one here would have deleted two of
    // the seven summaries the user asked for.
    const byScore = results
      .map((r) => ({ chunk: pool[r.index], score: r.score }))
      .sort((a, b) => b.score - a.score);
    const kept: RetrievedChunk[] = [];
    let used = 0;
    for (const { chunk } of byScore) {
      const len = chunk.chunk_text?.length ?? 0;
      // Always keep the top-scoring chunk, so a case can never render empty.
      if (kept.length > 0 && used + len > charBudget) continue;
      kept.push(chunk);
      used += len;
    }
    selected = kept.sort((a, b) => a.chunk_index - b.chunk_index);
  } else {
    selected = allChunks.slice(0, LOAD_CASE_MAX_CHUNKS);
  }

  const text = await renderChunksForAgent(
    selected,
    ctx.registry,
    { perCaseCharBudget: charBudget },
    ctx.emittedChunkIds
  );
  return {
    text,
    audit: {
      source_table: input.source_table,
      source_id: input.source_id,
      aspect: input.aspect ?? null,
      total_chunks_in_case: allChunks.length,
      selected_chunks: selected.length,
      reranked,
      // Recorded so a turn's trace shows whether the round budget actually bound
      // and by how much — the 44-credit turn was only diagnosable because the
      // audit already carried selected_chunks vs total_chunks_in_case.
      char_budget: charBudget,
      chunks_dropped_budget: reranked
        ? Math.min(allChunks.length, LOAD_CASE_MAX_CHUNKS) - selected.length
        : 0,
      rerank_scores: rerankScores?.slice(0, 20),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Tool 3: search_fresh
// ─────────────────────────────────────────────────────────────

interface SearchFreshInput {
  query: string;
  filters?: Partial<SearchFilters>;
  limit?: number;
}

async function executeSearchFresh(
  ctx: ToolContext,
  input: SearchFreshInput
): Promise<{ text: string; audit: Record<string, unknown> }> {
  if (!input.query || typeof input.query !== "string" || !input.query.trim()) {
    throw new Error("query is required");
  }

  // Session filters (UI-explicit) always win over tool-provided filters.
  const merged: SearchFilters = {
    ...(input.filters ?? {}),
    ...ctx.sessionFilters,
  };
  for (const k of Object.keys(merged) as (keyof SearchFilters)[]) {
    const v = merged[k];
    if (v === null || v === undefined || v === "") delete merged[k];
  }

  // #2 Query expansion: widen recall by retrieving over several doctrinal
  // phrasings, RRF-fused. The original query is always included first.
  const { queries, expanded } = await expandQueries(input.query);
  const { chunks } = await retrieveChunks(queries, merged, SEARCH_FRESH_POOL);
  if (chunks.length === 0) {
    return {
      text: JSON.stringify({
        cases: [],
        note: "No matches in the database for this query.",
        filters_applied: merged,
      }),
      audit: { candidates: 0, returned: 0, filters: merged, queries },
    };
  }

  const limit = Math.max(
    1,
    Math.min(input.limit ?? SEARCH_FRESH_DEFAULT_LIMIT, SEARCH_FRESH_MAX_LIMIT)
  );
  // Rerank against the ORIGINAL query (the user's actual intent — expansion was
  // only to broaden the candidate pool, not to shift relevance).
  const { results } = await rerank(
    input.query,
    chunks.map((c) => c.chunk_text),
    limit
  );

  // #3 Relevance floor: keep only chunks the cross-encoder scored on-point.
  const passing = results.filter((r) => r.score >= SEARCH_RELEVANCE_FLOOR);
  const topScore = results[0]?.score ?? null;

  if (passing.length === 0) {
    // Honest abstention — the DB has nothing the reranker considers on-point.
    // Returning the least-bad guesses here is what makes the model treat
    // marginal cases as authority, so we explicitly signal "nothing relevant".
    return {
      text: JSON.stringify({
        cases: [],
        note: "No directly relevant case found in the database for this query. Do not fabricate authority; tell the user no on-point case was found (use the general-guidance banner if you still want to help).",
        filters_applied: merged,
      }),
      audit: {
        query: input.query,
        queries,
        expanded,
        filters: merged,
        candidates: chunks.length,
        returned: 0,
        abstained: true,
        relevance_floor: SEARCH_RELEVANCE_FLOOR,
        top_score: topScore,
      },
    };
  }

  const reranked = passing.map((r) => chunks[r.index]);

  // Session-awareness: when fresh results include cases already cited earlier in
  // this chat, surface them FIRST and tell the model to prefer them. This keeps
  // a same-topic follow-up anchored to the established working set instead of
  // drifting onto new cases that merely share vocabulary — without DROPPING the
  // new cases, so a genuinely new sub-topic can still be answered.
  const sessionKeys = new Set(
    ctx.sessionStore.caseSummaries.map((s) => `${s.source_table}:${s.source_id}`)
  );
  const keyOf = (ch: RetrievedChunk) => `${ch.source_table}:${ch.source_id}`;
  const inSession = (ch: RetrievedChunk) => sessionKeys.has(keyOf(ch));
  const sessionFirst = [
    ...reranked.filter(inSession),
    ...reranked.filter((ch) => !inSession(ch)),
  ];
  const distinctSession = new Set(reranked.filter(inSession).map(keyOf)).size;
  const distinctNew = new Set(reranked.filter((ch) => !inSession(ch)).map(keyOf)).size;

  const body = await renderChunksForAgent(sessionFirst, ctx.registry, undefined, ctx.emittedChunkIds);
  const note =
    distinctSession > 0
      ? `NOTE: ${distinctSession} of these result(s) are cases already in this session (listed first). Prefer building your answer on them; only bring in the ${distinctNew} new case(s) if they add something the session cases genuinely lack.\n\n`
      : "";

  // #1 Surface retrieval quality so the model can judge whether to re-search
  // with a different phrasing before answering.
  const quality =
    topScore === null
      ? ""
      : `RETRIEVAL QUALITY: top relevance ${topScore.toFixed(2)} (${qualityLabel(topScore)}); ${reranked.length} on-point of ${chunks.length} candidates. If these are weak or tangential to the question, refine the query and search again before answering.\n\n`;

  return {
    text: quality + note + body,
    audit: {
      query: input.query,
      queries,
      expanded,
      filters: merged,
      candidates: chunks.length,
      returned: reranked.length,
      already_in_session: distinctSession,
      new_cases: distinctNew,
      dropped_below_floor: results.length - passing.length,
      relevance_floor: SEARCH_RELEVANCE_FLOOR,
      top_score: topScore,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Tool 4: lookup_by_citation
// ─────────────────────────────────────────────────────────────

interface LookupByCitationInput {
  citation?: string;
  title?: string;
}

async function executeLookupByCitation(
  ctx: ToolContext,
  input: LookupByCitationInput
): Promise<{ text: string; audit: Record<string, unknown> }> {
  if (!input.citation && !input.title) {
    throw new Error("Provide at least citation or title.");
  }
  const spec: IdentifierSpec = {
    citation: input.citation ?? null,
    title: input.title ?? null,
  };
  const { chunks, resolutions } = await lookupByIdentifier([spec]);
  if (chunks.length === 0) {
    return {
      text: JSON.stringify({ error: "no_match", resolutions }),
      audit: { resolutions, chunks: 0 },
    };
  }

  const selected = chunks.slice(0, LOAD_CASE_MAX_CHUNKS);
  const text = await renderChunksForAgent(
    selected,
    ctx.registry,
    { perCaseCharBudget: LOAD_CASE_PER_CASE_CHARS },
    ctx.emittedChunkIds
  );
  return {
    text,
    audit: { resolutions, chunks_returned: selected.length },
  };
}

// ─────────────────────────────────────────────────────────────
// Tool 5: expand_cited_cases (#3 — follow the citation graph)
// ─────────────────────────────────────────────────────────────

interface ExpandCitedCasesInput {
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
}

const EXPAND_MAX_NEIGHBOURS = 30;

async function executeExpandCitedCases(
  input: ExpandCitedCasesInput
): Promise<{ text: string; audit: Record<string, unknown> }> {
  if (!input.source_table || typeof input.source_id !== "number") {
    throw new Error("source_table and source_id are required");
  }

  const cited = await queryCitedCases(input.source_table, input.source_id);
  if (cited.length === 0) {
    return {
      text: JSON.stringify({
        cited_cases: [],
        note: "No extracted citations are recorded for this case.",
      }),
      audit: { cited_total: 0, resolved: 0 },
    };
  }

  const capped = cited.slice(0, EXPAND_MAX_NEIGHBOURS);
  const specs: IdentifierSpec[] = capped.map((c) => ({
    citation: c.citation,
    title: c.name || null,
  }));
  const resolutions = await resolveIdentifiers(specs);

  // De-dupe resolved neighbours by case key; exclude the origin case itself.
  const originKey = `${input.source_table}:${input.source_id}`;
  const seen = new Set<string>();
  const inDb: Array<{
    name: string;
    citation: string | null;
    source_table: string;
    source_id: number;
  }> = [];
  const notFound: Array<{ name: string; citation: string | null }> = [];

  resolutions.forEach((res, i) => {
    const ref = capped[i];
    const match = res.matches[0];
    if (!match) {
      notFound.push({ name: ref.name, citation: ref.citation });
      return;
    }
    const key = `${match.source_table}:${match.source_id}`;
    if (key === originKey || seen.has(key)) return;
    seen.add(key);
    inDb.push({
      name: ref.name,
      citation: ref.citation,
      source_table: match.source_table,
      source_id: match.source_id,
    });
  });

  const text = JSON.stringify(
    {
      cited_cases_in_db: inDb,
      not_in_db_count: notFound.length,
      note:
        inDb.length > 0
          ? "These authorities cited by the case are present in our database. Call load_case on the one(s) relevant to the user's question to read and cite them directly."
          : "None of this case's cited authorities were found in our database.",
    },
    null,
    2
  );

  return {
    text,
    audit: {
      cited_total: cited.length,
      resolved: inDb.length,
      not_found: notFound.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build a contextBuilder block for the given chunks, then rewrite the
 * `--- Case [N] ---` markers to the registry-canonical indices so every tool
 * result in this turn uses a consistent `[^n]` space.
 *
 * Uses a two-pass placeholder rename to avoid aliasing when local and registry
 * indices overlap (e.g. local [2] needs to become registry [5] while local [5]
 * also needs to be rewritten).
 */
/**
 * Measurement hook (off by default, no production effect).
 *
 * Every chunk the agent sends to the model passes through renderChunksForAgent,
 * so this is the one place that can answer "how much text are we sending twice?"
 * — e.g. when search_fresh surfaces a case's chunks and load_case then re-emits
 * the same ones. Set by scripts/measure_chunk_overlap.mts; never set in the app.
 */
export type ChunkEmissionSink = (emitted: Array<{ chunkId: number; chars: number }>) => void;
let emissionSink: ChunkEmissionSink | null = null;
export function setChunkEmissionSink(sink: ChunkEmissionSink | null): void {
  emissionSink = sink;
}

/**
 * Describe passages suppressed as duplicates, pointing at where the model
 * already has them. Grouped by case so the note stays short regardless of how
 * many chunks repeated.
 */
function describeRepeats(repeats: RetrievedChunk[], registry: CaseRegistry): string {
  if (repeats.length === 0) return "";
  const byCase = new Map<string, { index: number | null; count: number }>();
  for (const c of repeats) {
    const key = `${c.source_table}:${c.source_id}`;
    const known = registry
      .list()
      .find((x) => x.source_table === c.source_table && String(x.source_id) === String(c.source_id));
    const entry = byCase.get(key) ?? { index: known?.index ?? null, count: 0 };
    entry.count++;
    byCase.set(key, entry);
  }
  const parts = [...byCase.values()].map((e) =>
    e.index != null
      ? `${e.count} passage(s) already shown above under [^${e.index}]`
      : `${e.count} passage(s) already shown above`
  );
  return `\n\n(Omitted as duplicates — ${parts.join("; ")}. Use the text already in context.)`;
}

async function renderChunksForAgent(
  chunks: RetrievedChunk[],
  registry: CaseRegistry,
  buildOpts?: { perCaseCharBudget?: number; totalCharBudget?: number },
  emittedChunkIds?: Set<number>
): Promise<string> {
  // Drop passages the model already has. Filtering BEFORE buildContext is what
  // makes this a saving rather than a swap: the per-case char budget is a cap,
  // not a fill target, so removing duplicates renders less text — it does not
  // backfill with other chunks at the same cost.
  let toRender = chunks;
  let repeatNote = "";
  if (!emittedChunkIds && emissionSink) {
    emissionSink(chunks.map((c) => ({ chunkId: c.chunk_id, chars: c.chunk_text?.length ?? 0 })));
  }
  if (emittedChunkIds) {
    const fresh: RetrievedChunk[] = [];
    const repeats: RetrievedChunk[] = [];
    for (const c of chunks) {
      (emittedChunkIds.has(c.chunk_id) ? repeats : fresh).push(c);
    }
    // Mark everything seen — including repeats, which is a no-op, and fresh,
    // which must be recorded before any later call can re-request it.
    for (const c of chunks) emittedChunkIds.add(c.chunk_id);

    // Report what is actually SENT (post-suppression), so the measurement
    // script proves the dedup rather than re-measuring demand for it.
    if (emissionSink) {
      emissionSink(fresh.map((c) => ({ chunkId: c.chunk_id, chars: c.chunk_text?.length ?? 0 })));
    }

    if (fresh.length === 0) {
      // Every passage was already sent. Returning the note alone keeps the tool
      // honest (it did find the case) without paying for the text twice.
      return (
        "All passages for this request are already in context above." +
        describeRepeats(repeats, registry)
      ).trim();
    }
    toRender = fresh;
    repeatNote = describeRepeats(repeats, registry);
  }

  const { contextString, cases } = await buildContext(toRender, buildOpts);
  if (cases.length === 0) return contextString + repeatNote;

  const mapping: Array<{ localMarker: string; placeholder: string; finalMarker: string }> = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const registered = registry.upsert(c);
    mapping.push({
      localMarker: `--- Case [${c.index}] ---`,
      placeholder: `__AGENT_CASE_PLACEHOLDER_${i}__`,
      finalMarker: `--- Case [${registered.index}] ---`,
    });
  }

  let out = contextString;
  for (const m of mapping) out = out.replace(m.localMarker, m.placeholder);
  for (const m of mapping) out = out.replace(m.placeholder, m.finalMarker);
  return out + repeatNote;
}
