import type Anthropic from "@anthropic-ai/sdk";
import {
  retrieveChunks,
  lookupByIdentifier,
  type RetrievedChunk,
  type IdentifierSpec,
} from "../search";
import { rerank } from "../voyage";
import { buildContext, type AssembledCase } from "./contextBuilder";
import { queryAllChunksForCases, type SessionDocumentStore } from "./sessionStore";
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

const LOAD_CASE_MAX_CHUNKS = 30;
const LOAD_CASE_RERANK_POOL = 80;
const SEARCH_FRESH_POOL = 40;
const SEARCH_FRESH_DEFAULT_LIMIT = 10;
const SEARCH_FRESH_MAX_LIMIT = 20;

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
  | "lookup_by_citation";

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

export interface ToolContext {
  sessionStore: SessionDocumentStore;
  sessionFilters: SearchFilters;
  registry: CaseRegistry;
  trace: ToolCallRecord[];
}

// ─────────────────────────────────────────────────────────────
// Tool definitions — schemas handed to the Anthropic SDK.
// ─────────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "list_session_cases",
    description:
      "Returns every case already cited in this chat session, in recency order. Use this FIRST whenever the user refers to a prior case by pronoun or role noun ('this judgment', 'the respondent', 'the bench', 'that case') so you can identify which case they mean before loading more content. Each entry includes a tier marker (hot = most recently-discussed, cold = cached earlier) and a headnotes snippet for cold-tier cases.",
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
];

// ─────────────────────────────────────────────────────────────
// Dispatcher — called by agent.ts for each tool_use block.
// Always resolves to a string (never throws); errors are returned as JSON so
// the model can see them and decide how to proceed.
// ─────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
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
        const out = await executeLoadCase(ctx, input as unknown as LoadCaseInput);
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
  const cases = ctx.sessionStore.caseSummaries.map((s) => {
    const cold = ctx.sessionStore.coldCases.find(
      (c) => c.source_id === s.source_id && c.source_table === s.source_table
    );
    return {
      recency_rank: s.recency_rank,
      tier: s.tier,
      source_table: s.source_table,
      source_id: s.source_id,
      title: s.title,
      citation: s.citation,
      headnotes_snippet: cold?.headnotes_snippet ?? null,
    };
  });
  const text =
    cases.length === 0
      ? JSON.stringify({ cases: [], note: "No cases cited in this session yet." }, null, 2)
      : JSON.stringify({ cases }, null, 2);
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
  input: LoadCaseInput
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
    selected = results
      .map((r) => pool[r.index])
      .sort((a, b) => a.chunk_index - b.chunk_index);
    rerankScores = results.map((r) => ({
      chunk_id: pool[r.index].chunk_id,
      score: r.score,
    }));
  } else {
    selected = allChunks.slice(0, LOAD_CASE_MAX_CHUNKS);
  }

  const text = await renderChunksForAgent(selected, ctx.registry);
  return {
    text,
    audit: {
      source_table: input.source_table,
      source_id: input.source_id,
      aspect: input.aspect ?? null,
      total_chunks_in_case: allChunks.length,
      selected_chunks: selected.length,
      reranked,
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

  const { chunks } = await retrieveChunks([input.query], merged, SEARCH_FRESH_POOL);
  if (chunks.length === 0) {
    return {
      text: JSON.stringify({
        cases: [],
        note: "No matches in the database for this query.",
        filters_applied: merged,
      }),
      audit: { candidates: 0, returned: 0, filters: merged },
    };
  }

  const limit = Math.max(
    1,
    Math.min(input.limit ?? SEARCH_FRESH_DEFAULT_LIMIT, SEARCH_FRESH_MAX_LIMIT)
  );
  const { results } = await rerank(
    input.query,
    chunks.map((c) => c.chunk_text),
    limit
  );
  const reranked = results.map((r) => chunks[r.index]);

  const text = await renderChunksForAgent(reranked, ctx.registry);
  return {
    text,
    audit: {
      query: input.query,
      filters: merged,
      candidates: chunks.length,
      returned: reranked.length,
      top_score: results[0]?.score ?? null,
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
  const text = await renderChunksForAgent(selected, ctx.registry);
  return {
    text,
    audit: { resolutions, chunks_returned: selected.length },
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
async function renderChunksForAgent(
  chunks: RetrievedChunk[],
  registry: CaseRegistry
): Promise<string> {
  const { contextString, cases } = await buildContext(chunks);
  if (cases.length === 0) return contextString;

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
  return out;
}
