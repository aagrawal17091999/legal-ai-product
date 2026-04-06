import { understandQuery, mergeFilters, type QueryUnderstanding } from "./queryUnderstanding";
import { retrieveChunks, type RetrievedChunk, type RetrievalTrace } from "../search";
import { rerank, VOYAGE_RERANK_MODEL } from "../voyage";
import { buildContext, toCitedCases, type AssembledCase, type ContextBuildTrace } from "./contextBuilder";
import { logError } from "../error-logger";
import type { ChatMessage, SearchFilters, CitedCase } from "@/types";

/**
 * Full RAG pipeline for a single user turn.
 *
 * Stages (all recorded as PipelineStepRecord entries for rag_pipeline_steps):
 *   1. understand      — Haiku rewrites + HyDE + implicit filters
 *   2. embed_queries   — Voyage multi-query embed (timed separately from SQL)
 *   3. retrieve        — chunk-level FTS + vector, RRF fused
 *   4. rerank          — Voyage rerank-2 against original user message
 *   5. context_build   — group chunks → cases, attach metadata, enforce budget
 *
 * Step 6 `generate` is owned by the route handler (it streams Claude's response)
 * and is appended to RagResult.steps there.
 */

const CANDIDATE_POOL = 40;
const TOP_AFTER_RERANK = 12;

export type PipelineStepName =
  | "understand"
  | "embed_queries"
  | "retrieve"
  | "rerank"
  | "context_build"
  | "generate";

export type PipelineStepStatus = "success" | "error" | "fallback" | "skipped";

export interface PipelineStepRecord {
  step_order: number;
  step: PipelineStepName;
  status: PipelineStepStatus;
  duration_ms: number;
  started_at: string; // ISO timestamp
  error: string | null;
  data: Record<string, unknown>;
}

export interface QueryEmbeddingRecord {
  query_index: number;
  query_type: "rewritten" | "hyde";
  query_text: string;
  embedding: number[];
}

export interface RagResult {
  needsRetrieval: boolean;
  understanding: QueryUnderstanding;
  effectiveFilters: SearchFilters;
  candidateChunks: RetrievedChunk[];
  rerankedChunks: RetrievedChunk[];
  contextString: string;
  cases: AssembledCase[];
  citedCases: CitedCase[];
  /** Per-stage audit records for rag_pipeline_steps. Route handler appends the generate step. */
  steps: PipelineStepRecord[];
  /** Query-side embedding vectors for rag_query_embeddings. Empty if retrieval was skipped. */
  queryEmbeddings: QueryEmbeddingRecord[];
  timings: {
    understandMs: number;
    embedMs: number;
    retrieveMs: number;
    rerankMs: number;
    contextMs: number;
    totalMs: number;
  };
}

export async function runRagPipeline(
  userMessage: string,
  history: ChatMessage[],
  sessionFilters: SearchFilters
): Promise<RagResult> {
  const t0 = Date.now();
  const steps: PipelineStepRecord[] = [];

  // ─────────────────────────────────────────────────────────────
  // Step 1: query understanding
  // ─────────────────────────────────────────────────────────────
  const tUnderstandStart = Date.now();
  const understandStartedAt = new Date(tUnderstandStart).toISOString();
  const understanding = await understandQuery(userMessage, history);
  const tUnderstand = Date.now();

  steps.push({
    step_order: 1,
    step: "understand",
    status: understanding.audit.fallback ? "fallback" : "success",
    duration_ms: tUnderstand - tUnderstandStart,
    started_at: understandStartedAt,
    error: understanding.audit.fallback_reason,
    data: {
      model: understanding.audit.model,
      input_tokens: understanding.audit.input_tokens,
      output_tokens: understanding.audit.output_tokens,
      needs_retrieval: understanding.needs_retrieval,
      rewritten_queries: understanding.rewritten_queries,
      hyde_passage_length: understanding.hyde_passage.length,
      implicit_filters: understanding.implicit_filters,
      history_turns_sent: Math.min(history.length, 6),
      user_message_length: userMessage.length,
      raw_response_preview: understanding.audit.raw_response
        ? understanding.audit.raw_response.slice(0, 500)
        : null,
    },
  });

  if (!understanding.needs_retrieval) {
    // Chitchat — no retrieval, no context. Record the remaining pipeline
    // steps as "skipped" so the audit log is still consistent (5 rows).
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const skippedData = { reason: "needs_retrieval=false" };
    for (let i = 0; i < 4; i++) {
      steps.push({
        step_order: 2 + i,
        step: (["embed_queries", "retrieve", "rerank", "context_build"] as PipelineStepName[])[i],
        status: "skipped",
        duration_ms: 0,
        started_at: nowIso,
        error: null,
        data: skippedData,
      });
    }
    return {
      needsRetrieval: false,
      understanding,
      effectiveFilters: sessionFilters,
      candidateChunks: [],
      rerankedChunks: [],
      contextString: "",
      cases: [],
      citedCases: [],
      steps,
      queryEmbeddings: [],
      timings: {
        understandMs: tUnderstand - tUnderstandStart,
        embedMs: 0,
        retrieveMs: 0,
        rerankMs: 0,
        contextMs: 0,
        totalMs: tUnderstand - t0,
      },
    };
  }

  const effectiveFilters = mergeFilters(sessionFilters, understanding.implicit_filters);

  // Queries: rewritten + HyDE (if long enough).
  const rewritten = understanding.rewritten_queries;
  const hyde = understanding.hyde_passage;
  const queries = [...rewritten];
  const hydeIncluded = Boolean(hyde && hyde.length > 20);
  if (hydeIncluded) queries.push(hyde);

  // ─────────────────────────────────────────────────────────────
  // Steps 2 + 3: embed queries + retrieve (one call, split timing)
  // ─────────────────────────────────────────────────────────────
  const tRetrieveWrapperStart = Date.now();
  const retrieveWrapperStartedAt = new Date(tRetrieveWrapperStart).toISOString();
  let retrieval: { chunks: RetrievedChunk[]; embeddings: number[][]; trace: RetrievalTrace };
  try {
    retrieval = await retrieveChunks(queries, effectiveFilters, CANDIDATE_POOL);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    // Record embed + retrieve as errors, skip the rest.
    steps.push({
      step_order: 2,
      step: "embed_queries",
      status: "error",
      duration_ms: now - tRetrieveWrapperStart,
      started_at: retrieveWrapperStartedAt,
      error: reason,
      data: { query_count: queries.length },
    });
    steps.push({
      step_order: 3,
      step: "retrieve",
      status: "error",
      duration_ms: 0,
      started_at: nowIso,
      error: reason,
      data: {},
    });
    for (let i = 0; i < 2; i++) {
      steps.push({
        step_order: 4 + i,
        step: (["rerank", "context_build"] as PipelineStepName[])[i],
        status: "skipped",
        duration_ms: 0,
        started_at: nowIso,
        error: null,
        data: { reason: "retrieval-failed" },
      });
    }
    throw err;
  }
  const { chunks: candidateChunks, embeddings, trace: retrievalTrace } = retrieval;

  steps.push({
    step_order: 2,
    step: "embed_queries",
    status: "success",
    duration_ms: retrievalTrace.embed.duration_ms,
    started_at: retrieveWrapperStartedAt,
    error: null,
    data: {
      model: retrievalTrace.embed.model,
      query_count: retrievalTrace.embed.query_count,
      total_tokens: retrievalTrace.embed.tokens,
      queries,
      hyde_included: hydeIncluded,
    },
  });

  steps.push({
    step_order: 3,
    step: "retrieve",
    status: "success",
    duration_ms: retrievalTrace.sql_duration_ms,
    started_at: new Date(tRetrieveWrapperStart + retrievalTrace.embed.duration_ms).toISOString(),
    error: null,
    data: {
      effective_filters: effectiveFilters,
      candidates_per_query: CANDIDATE_POOL,
      per_query: retrievalTrace.per_query,
      fused_count: retrievalTrace.fused_count,
      top_candidates: retrievalTrace.top_candidates,
    },
  });

  // Build the queryEmbeddings list for rag_query_embeddings.
  const queryEmbeddings: QueryEmbeddingRecord[] = queries.map((q, i) => ({
    query_index: i,
    query_type: hydeIncluded && i === queries.length - 1 ? "hyde" : "rewritten",
    query_text: q,
    embedding: embeddings[i],
  }));

  if (candidateChunks.length === 0) {
    // No hits. Still record rerank + context_build as skipped so the log
    // has a complete 5-step trace for every message.
    const nowIso = new Date().toISOString();
    steps.push({
      step_order: 4,
      step: "rerank",
      status: "skipped",
      duration_ms: 0,
      started_at: nowIso,
      error: null,
      data: { reason: "no-candidates" },
    });
    const tCtxStart = Date.now();
    const empty = await buildContext([]);
    const tCtxEnd = Date.now();
    steps.push({
      step_order: 5,
      step: "context_build",
      status: "success",
      duration_ms: tCtxEnd - tCtxStart,
      started_at: new Date(tCtxStart).toISOString(),
      error: null,
      data: empty.trace as unknown as Record<string, unknown>,
    });

    return {
      needsRetrieval: true,
      understanding,
      effectiveFilters,
      candidateChunks: [],
      rerankedChunks: [],
      contextString: empty.contextString,
      cases: empty.cases,
      citedCases: [],
      steps,
      queryEmbeddings,
      timings: {
        understandMs: tUnderstand - tUnderstandStart,
        embedMs: retrievalTrace.embed.duration_ms,
        retrieveMs: retrievalTrace.sql_duration_ms,
        rerankMs: 0,
        contextMs: tCtxEnd - tCtxStart,
        totalMs: tCtxEnd - t0,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Step 4: rerank against the ORIGINAL user message
  // ─────────────────────────────────────────────────────────────
  const tRerankStart = Date.now();
  const rerankStartedAt = new Date(tRerankStart).toISOString();
  let rerankedChunks: RetrievedChunk[];
  let rerankStatus: PipelineStepStatus = "success";
  let rerankError: string | null = null;
  let rerankTokens = 0;
  let rerankScored: Array<{
    chunk_id: number;
    rerank_score: number;
    prev_rrf_rank: number;
    new_rank: number;
  }> = [];

  try {
    const documents = candidateChunks.map((c) => c.chunk_text);
    const { results: rerankResults, totalTokens } = await rerank(
      userMessage,
      documents,
      TOP_AFTER_RERANK
    );
    rerankTokens = totalTokens;
    rerankedChunks = rerankResults.map((r) => candidateChunks[r.index]);
    rerankScored = rerankResults.map((r, newRank) => ({
      chunk_id: candidateChunks[r.index].chunk_id,
      rerank_score: r.score,
      prev_rrf_rank: r.index, // position in candidateChunks (already sorted by RRF)
      new_rank: newRank,
    }));
  } catch (err) {
    rerankStatus = "fallback";
    rerankError = err instanceof Error ? err.message : String(err);
    logError({
      category: "search",
      message: `rerank failed, falling back to RRF order: ${rerankError}`,
      error: err,
      severity: "warning",
      metadata: { step: "rerank", candidateCount: candidateChunks.length },
    });
    rerankedChunks = candidateChunks.slice(0, TOP_AFTER_RERANK);
    rerankScored = rerankedChunks.map((c, i) => ({
      chunk_id: c.chunk_id,
      rerank_score: c.rrf_score, // fallback: reuse the fused RRF score
      prev_rrf_rank: i,
      new_rank: i,
    }));
  }
  const tRerankEnd = Date.now();

  steps.push({
    step_order: 4,
    step: "rerank",
    status: rerankStatus,
    duration_ms: tRerankEnd - tRerankStart,
    started_at: rerankStartedAt,
    error: rerankError,
    data: {
      model: VOYAGE_RERANK_MODEL,
      input_count: candidateChunks.length,
      kept_count: rerankedChunks.length,
      top_k_config: TOP_AFTER_RERANK,
      total_tokens: rerankTokens,
      query: userMessage,
      scored: rerankScored,
    },
  });

  // ─────────────────────────────────────────────────────────────
  // Step 5: assemble context (group cases, fetch extraction, sign PDFs)
  // ─────────────────────────────────────────────────────────────
  const tContextStart = Date.now();
  const contextStartedAt = new Date(tContextStart).toISOString();
  const { contextString, cases, trace: contextTrace } = await buildContext(rerankedChunks);
  const tContextEnd = Date.now();
  const citedCases = toCitedCases(cases);

  steps.push({
    step_order: 5,
    step: "context_build",
    status: "success",
    duration_ms: tContextEnd - tContextStart,
    started_at: contextStartedAt,
    error: null,
    data: contextTrace as unknown as Record<string, unknown>,
  });

  return {
    needsRetrieval: true,
    understanding,
    effectiveFilters,
    candidateChunks,
    rerankedChunks,
    contextString,
    cases,
    citedCases,
    steps,
    queryEmbeddings,
    timings: {
      understandMs: tUnderstand - tUnderstandStart,
      embedMs: retrievalTrace.embed.duration_ms,
      retrieveMs: retrievalTrace.sql_duration_ms,
      rerankMs: tRerankEnd - tRerankStart,
      contextMs: tContextEnd - tContextStart,
      totalMs: tContextEnd - t0,
    },
  };
}

export type { ContextBuildTrace };
