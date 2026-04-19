import pool from "./db";
import { embedQueries, VOYAGE_EMBED_MODEL } from "./voyage";
import { logError } from "./error-logger";
import { toStringArray } from "./metadata";
import type { SearchFilters } from "@/types";

const RRF_K = 60; // Reciprocal Rank Fusion smoothing constant
const DEFAULT_CANDIDATES_PER_QUERY = 40;

export { RRF_K, DEFAULT_CANDIDATES_PER_QUERY, VOYAGE_EMBED_MODEL };

/**
 * Chunk-level hybrid retrieval for the RAG pipeline.
 *
 * - Runs FTS + vector search over case_chunks for each rewritten query.
 * - Fuses hits across (query, method) pairs using Reciprocal Rank Fusion.
 * - Returns the top N chunks keyed on chunk_id, with case metadata attached.
 *
 * Why chunk-level, not case-level:
 *   The previous hybridSearch collapsed to one chunk per case via DISTINCT ON,
 *   which threw away the passage that actually answered the question for long
 *   judgments. Chunk-level retrieval keeps the best passage(s) per case and
 *   lets downstream reranking + context assembly decide how to group them.
 */

export interface RetrievedChunk {
  chunk_id: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  chunk_index: number;
  chunk_text: string;
  rrf_score: number;
  /** Paragraph numbers covered by this chunk. NULL for legacy chunks not yet
   *  re-chunked by the paragraph-aware pipeline. When present, the context
   *  builder emits `¶<num>` markers so the model can cite `[^n, ¶p]`. */
  paragraph_numbers: string[] | null;
  case: RetrievedCaseMeta;
}

export interface RetrievedCaseMeta {
  title: string;
  citation: string | null;
  court: string;
  judge: string | null;
  decision_date: string | null;
  petitioner: string | null;
  respondent: string | null;
  disposal_nature: string | null;
  year: number | null;
  path: string | null;
  pdf_url: string | null;
  /** Structured metadata from extraction, carried through retrieval so the
   *  post-rerank soft-hint boost can match implicit filters (actCited,
   *  judgeName, keyword) without a second round-trip. Arrays may be empty. */
  acts_cited: string[];
  judge_names: string[];
  keywords: string[];
}

interface RawChunkHit {
  chunk_id: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  chunk_index: number;
  chunk_text: string;
  paragraph_numbers: string[] | null;
  case: RetrievedCaseMeta;
}

interface MethodHits {
  hits: RawChunkHit[];
  sc: number; // SC table hit count
  hc: number; // HC table hit count
}

export interface RetrievalTrace {
  embed: {
    model: string;
    tokens: number;
    duration_ms: number;
    query_count: number;
  };
  sql_duration_ms: number;
  per_query: Array<{
    query_index: number;
    query: string;
    fts_sc: number;
    fts_hc: number;
    vec_sc: number;
    vec_hc: number;
  }>;
  fused_count: number;
  /** Top candidates post-RRF, with provenance tags like "fts_q0", "vec_q1". */
  top_candidates: Array<{
    chunk_id: number;
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
    chunk_index: number;
    rrf_score: number;
    found_in: string[];
  }>;
}

export interface RetrieveChunksResult {
  chunks: RetrievedChunk[];
  /** Raw query-side embeddings, index-aligned with `queries`. Returned so the caller can persist them in rag_query_embeddings. */
  embeddings: number[][];
  trace: RetrievalTrace;
}

/**
 * Retrieve top-N chunks for one or more search queries.
 *
 * @param queries - rewritten/HyDE queries from the query-understanding step.
 *                  Every query is embedded once and run through both FTS and
 *                  vector search; results are RRF-fused.
 * @param filters - SearchFilters applied to the joined case row (court, year,
 *                  extraction fields). Session filters win over implicit ones
 *                  — the caller is responsible for merging.
 * @param topK    - how many fused chunks to return (default 40).
 */
export async function retrieveChunks(
  queries: string[],
  filters: SearchFilters,
  topK: number = DEFAULT_CANDIDATES_PER_QUERY
): Promise<RetrieveChunksResult> {
  if (queries.length === 0) {
    return {
      chunks: [],
      embeddings: [],
      trace: emptyTrace(),
    };
  }

  try {
    // 1. Embed every rewritten query in one Voyage call.
    const tEmbedStart = Date.now();
    const { embeddings, totalTokens } = await embedQueries(queries);
    const embedDurationMs = Date.now() - tEmbedStart;

    // 2. Run FTS + vector for each query, in parallel.
    // scoreMap keyed on chunk_id; value tracks RRF score and provenance tags.
    interface ScoreEntry {
      score: number;
      chunk: RawChunkHit;
      foundIn: Set<string>;
    }
    const scoreMap = new Map<number, ScoreEntry>();

    const addRrf = (ranked: RawChunkHit[], tag: string) => {
      ranked.forEach((chunk, index) => {
        const rrf = 1 / (RRF_K + index + 1);
        const existing = scoreMap.get(chunk.chunk_id);
        if (existing) {
          existing.score += rrf;
          existing.foundIn.add(tag);
        } else {
          scoreMap.set(chunk.chunk_id, { score: rrf, chunk, foundIn: new Set([tag]) });
        }
      });
    };

    const tSqlStart = Date.now();
    const perQueryResults = await Promise.all(
      queries.map(async (q, qi) => {
        const [fts, vec] = await Promise.all([
          ftsChunks(q, filters, DEFAULT_CANDIDATES_PER_QUERY),
          vectorChunks(embeddings[qi], filters, DEFAULT_CANDIDATES_PER_QUERY),
        ]);
        return { qi, q, fts, vec };
      })
    );
    const sqlDurationMs = Date.now() - tSqlStart;

    const perQueryTrace: RetrievalTrace["per_query"] = [];
    for (const { qi, q, fts, vec } of perQueryResults) {
      addRrf(fts.hits, `fts_q${qi}`);
      addRrf(vec.hits, `vec_q${qi}`);
      perQueryTrace.push({
        query_index: qi,
        query: q,
        fts_sc: fts.sc,
        fts_hc: fts.hc,
        vec_sc: vec.sc,
        vec_hc: vec.hc,
      });
    }

    // 3. Sort by fused RRF score and take top-K.
    const fused = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
    const top = fused.slice(0, topK);

    const chunks: RetrievedChunk[] = top.map((entry) => ({
      chunk_id: entry.chunk.chunk_id,
      source_table: entry.chunk.source_table,
      source_id: entry.chunk.source_id,
      chunk_index: entry.chunk.chunk_index,
      chunk_text: entry.chunk.chunk_text,
      rrf_score: entry.score,
      paragraph_numbers: entry.chunk.paragraph_numbers,
      case: entry.chunk.case,
    }));

    const trace: RetrievalTrace = {
      embed: {
        model: VOYAGE_EMBED_MODEL,
        tokens: totalTokens,
        duration_ms: embedDurationMs,
        query_count: queries.length,
      },
      sql_duration_ms: sqlDurationMs,
      per_query: perQueryTrace,
      fused_count: fused.length,
      top_candidates: top.map((entry) => ({
        chunk_id: entry.chunk.chunk_id,
        source_table: entry.chunk.source_table,
        source_id: entry.chunk.source_id,
        chunk_index: entry.chunk.chunk_index,
        rrf_score: entry.score,
        found_in: Array.from(entry.foundIn),
      })),
    };

    return { chunks, embeddings, trace };
  } catch (err) {
    logError({
      category: "search",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      metadata: { queries, filters },
    });
    throw err;
  }
}

function emptyTrace(): RetrievalTrace {
  return {
    embed: { model: VOYAGE_EMBED_MODEL, tokens: 0, duration_ms: 0, query_count: 0 },
    sql_duration_ms: 0,
    per_query: [],
    fused_count: 0,
    top_candidates: [],
  };
}

/**
 * Chunk-level full-text search. Joins each chunk back to its case row so
 * filters (court, year, extraction metadata) can be applied and metadata
 * returned in one round-trip.
 */
async function ftsChunks(
  query: string,
  filters: SearchFilters,
  limit: number
): Promise<MethodHits> {
  const searchSC = !filters.court || filters.court === "Supreme Court of India";
  const searchHC = !filters.court || filters.court !== "Supreme Court of India";

  const results: RawChunkHit[] = [];
  let scCount = 0;
  let hcCount = 0;

  if (searchSC) {
    const { clauses, params } = buildCaseFilterClauses(filters, "sc");
    const paramOffset = params.length;
    const sql = `
      SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_index, ch.chunk_text,
             ch.paragraph_numbers,
             sc.title, sc.citation, sc.court, sc.judge, sc.decision_date::text AS decision_date,
             sc.petitioner, sc.respondent, sc.disposal_nature, sc.year, sc.path,
             sc.acts_cited, sc.judge_names, sc.keywords,
             -- SC has no pdf_url column; contextBuilder presigns from year/path.
             NULL::text AS pdf_url,
             ts_rank(to_tsvector('english', ch.chunk_text),
                     plainto_tsquery('english', $${paramOffset + 1})) AS rank
      FROM case_chunks ch
      JOIN supreme_court_cases sc ON ch.source_id = sc.id
      WHERE ch.source_table = 'supreme_court_cases'
        AND to_tsvector('english', ch.chunk_text)
            @@ plainto_tsquery('english', $${paramOffset + 1})
        ${clauses}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    const { rows } = await pool.query(sql, [...params, query]);
    scCount = rows.length;
    for (const r of rows) results.push(toHit(r, "supreme_court_cases"));
  }

  if (searchHC) {
    const { clauses, params } = buildCaseFilterClauses(filters, "hc");
    const paramOffset = params.length;
    const sql = `
      SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_index, ch.chunk_text,
             ch.paragraph_numbers,
             hc.title, NULL::text AS citation, hc.court_name AS court, hc.judge,
             hc.decision_date::text AS decision_date,
             NULL::text AS petitioner, NULL::text AS respondent,
             hc.disposal_nature, hc.year, NULL::text AS path, hc.pdf_url,
             hc.acts_cited, hc.judge_names, hc.keywords,
             ts_rank(to_tsvector('english', ch.chunk_text),
                     plainto_tsquery('english', $${paramOffset + 1})) AS rank
      FROM case_chunks ch
      JOIN high_court_cases hc ON ch.source_id = hc.id
      WHERE ch.source_table = 'high_court_cases'
        AND to_tsvector('english', ch.chunk_text)
            @@ plainto_tsquery('english', $${paramOffset + 1})
        ${clauses}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;
    const { rows } = await pool.query(sql, [...params, query]);
    hcCount = rows.length;
    for (const r of rows) results.push(toHit(r, "high_court_cases"));
  }

  // Cross-table merge by rank (ts_rank scales are comparable enough for top-K).
  return { hits: results.slice(0, limit), sc: scCount, hc: hcCount };
}

/**
 * Chunk-level vector search. Note: no DISTINCT ON — we keep every matching
 * chunk, so a long judgment can contribute several relevant passages.
 */
async function vectorChunks(
  embedding: number[],
  filters: SearchFilters,
  limit: number
): Promise<MethodHits> {
  const embeddingStr = `[${embedding.join(",")}]`;
  const searchSC = !filters.court || filters.court === "Supreme Court of India";
  const searchHC = !filters.court || filters.court !== "Supreme Court of India";

  const results: RawChunkHit[] = [];
  let scCount = 0;
  let hcCount = 0;

  if (searchSC) {
    const { clauses, params } = buildCaseFilterClauses(filters, "sc");
    const paramOffset = params.length;
    const sql = `
      SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_index, ch.chunk_text,
             ch.paragraph_numbers,
             sc.title, sc.citation, sc.court, sc.judge, sc.decision_date::text AS decision_date,
             sc.petitioner, sc.respondent, sc.disposal_nature, sc.year, sc.path,
             sc.acts_cited, sc.judge_names, sc.keywords,
             -- SC has no pdf_url column; contextBuilder presigns from year/path.
             NULL::text AS pdf_url,
             ch.embedding <=> $${paramOffset + 1}::vector AS distance
      FROM case_chunks ch
      JOIN supreme_court_cases sc ON ch.source_id = sc.id
      WHERE ch.source_table = 'supreme_court_cases'
        ${clauses}
      ORDER BY ch.embedding <=> $${paramOffset + 1}::vector
      LIMIT ${limit}
    `;
    const { rows } = await pool.query(sql, [...params, embeddingStr]);
    scCount = rows.length;
    for (const r of rows) results.push(toHit(r, "supreme_court_cases"));
  }

  if (searchHC) {
    const { clauses, params } = buildCaseFilterClauses(filters, "hc");
    const paramOffset = params.length;
    const sql = `
      SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_index, ch.chunk_text,
             ch.paragraph_numbers,
             hc.title, NULL::text AS citation, hc.court_name AS court, hc.judge,
             hc.decision_date::text AS decision_date,
             NULL::text AS petitioner, NULL::text AS respondent,
             hc.disposal_nature, hc.year, NULL::text AS path, hc.pdf_url,
             hc.acts_cited, hc.judge_names, hc.keywords,
             ch.embedding <=> $${paramOffset + 1}::vector AS distance
      FROM case_chunks ch
      JOIN high_court_cases hc ON ch.source_id = hc.id
      WHERE ch.source_table = 'high_court_cases'
        ${clauses}
      ORDER BY ch.embedding <=> $${paramOffset + 1}::vector
      LIMIT ${limit}
    `;
    const { rows } = await pool.query(sql, [...params, embeddingStr]);
    hcCount = rows.length;
    for (const r of rows) results.push(toHit(r, "high_court_cases"));
  }

  return { hits: results.slice(0, limit), sc: scCount, hc: hcCount };
}

function toHit(
  r: Record<string, unknown>,
  source_table: "supreme_court_cases" | "high_court_cases"
): RawChunkHit {
  return {
    chunk_id: r.chunk_id as number,
    source_table,
    source_id: r.source_id as number,
    chunk_index: r.chunk_index as number,
    chunk_text: (r.chunk_text as string) || "",
    paragraph_numbers: toParagraphNumbers(r.paragraph_numbers),
    case: {
      title: (r.title as string) || "",
      citation: (r.citation as string | null) ?? null,
      court: (r.court as string) || "",
      judge: (r.judge as string | null) ?? null,
      decision_date: (r.decision_date as string | null) ?? null,
      petitioner: (r.petitioner as string | null) ?? null,
      respondent: (r.respondent as string | null) ?? null,
      disposal_nature: (r.disposal_nature as string | null) ?? null,
      year: (r.year as number | null) ?? null,
      path: (r.path as string | null) ?? null,
      pdf_url: (r.pdf_url as string | null) ?? null,
      acts_cited: toStringArray(r.acts_cited),
      judge_names: toStringArray(r.judge_names),
      keywords: toStringArray(r.keywords),
    },
  };
}

/**
 * Build SQL filter clauses for a case table. Two call shapes:
 *   - { prefixColumns: true } (default): emits `sc.year`, `hc.court_name`, etc.
 *     for use when joined into a chunk query aliased as sc/hc.
 *   - { prefixColumns: false }: emits raw column names for direct queries
 *     against supreme_court_cases / high_court_cases.
 * Returns a " AND ..." fragment to append after an existing WHERE.
 */
export function buildCaseFilterClauses(
  filters: SearchFilters,
  tableAlias: "sc" | "hc",
  options: { prefixColumns?: boolean } = {}
): { clauses: string; params: unknown[] } {
  const prefix = options.prefixColumns === false ? "" : `${tableAlias}.`;
  const parts: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (tableAlias === "sc") {
    if (filters.yearFrom) {
      parts.push(`AND ${prefix}year >= $${p++}`);
      params.push(filters.yearFrom);
    }
    if (filters.yearTo) {
      parts.push(`AND ${prefix}year <= $${p++}`);
      params.push(filters.yearTo);
    }
  } else {
    if (filters.court && filters.court !== "Supreme Court of India") {
      parts.push(`AND ${prefix}court_name = $${p++}`);
      params.push(filters.court);
    }
    if (filters.yearFrom) {
      parts.push(`AND ${prefix}year >= $${p++}`);
      params.push(filters.yearFrom);
    }
    if (filters.yearTo) {
      parts.push(`AND ${prefix}year <= $${p++}`);
      params.push(filters.yearTo);
    }
  }

  if (filters.citation) {
    parts.push(`AND ${prefix}extracted_citation = $${p++}`);
    params.push(filters.citation);
  }
  if (filters.extractedPetitioner) {
    parts.push(`AND ${prefix}extracted_petitioner = $${p++}`);
    params.push(filters.extractedPetitioner);
  }
  if (filters.extractedRespondent) {
    parts.push(`AND ${prefix}extracted_respondent = $${p++}`);
    params.push(filters.extractedRespondent);
  }
  if (filters.caseCategory) {
    parts.push(`AND ${prefix}case_category = $${p++}`);
    params.push(filters.caseCategory);
  }
  if (filters.caseNumber) {
    parts.push(`AND ${prefix}case_number = $${p++}`);
    params.push(filters.caseNumber);
  }
  if (filters.judgeName) {
    parts.push(`AND ${prefix}judge_names @> $${p++}::jsonb`);
    params.push(JSON.stringify([filters.judgeName]));
  }
  if (filters.actCited) {
    parts.push(`AND ${prefix}acts_cited @> $${p++}::jsonb`);
    params.push(JSON.stringify([filters.actCited]));
  }
  if (filters.keyword) {
    parts.push(`AND ${prefix}keywords @> $${p++}::jsonb`);
    params.push(JSON.stringify([filters.keyword]));
  }

  return { clauses: parts.join(" "), params };
}

// ─────────────────────────────────────────────────────────────
// Direct case lookup by identifier (citation / title / shorthand)
// ─────────────────────────────────────────────────────────────

export interface IdentifierSpec {
  citation: string | null;
  title: string | null;
  /** If the router already matched this spec to a known case, these short-circuit the lookup. */
  source_table?: "supreme_court_cases" | "high_court_cases";
  source_id?: number;
}

export interface IdentifierMatch {
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  /** Short reason the row matched, useful for debugging ("exact_citation" | "title_ilike" | "party_ilike" | "session_pin"). */
  match_reason: string;
}

export interface LookupByIdentifierResult {
  chunks: RetrievedChunk[];
  /** One entry per spec, indicating how/whether it was resolved. */
  resolutions: Array<{
    spec: IdentifierSpec;
    matches: IdentifierMatch[];
  }>;
}

const MAX_CHUNKS_PER_LOOKUP_CASE = 15;

/**
 * Resolve user-named case references to concrete case rows and return all of
 * their chunks. Used for task=specific_case / compare / summary where top-k
 * similarity would risk missing the exact case the user named.
 *
 * Resolution order per spec:
 *   1. Pinned (source_table + source_id set by the router) — skip the search.
 *   2. Citation exact match on extracted_citation, then legacy citation column.
 *   3. Title ILIKE across title / extracted parties / petitioner / respondent.
 *
 * Returns every chunk of every matched case (up to MAX_CHUNKS_PER_LOOKUP_CASE
 * per case, chunk_index order). The context builder's per-case budget trims
 * further.
 */
export async function lookupByIdentifier(
  specs: IdentifierSpec[]
): Promise<LookupByIdentifierResult> {
  if (specs.length === 0) return { chunks: [], resolutions: [] };

  const resolutions: LookupByIdentifierResult["resolutions"] = [];
  const allMatches: IdentifierMatch[] = [];

  for (const spec of specs) {
    if (spec.source_table && typeof spec.source_id === "number") {
      const pinned: IdentifierMatch = {
        source_table: spec.source_table,
        source_id: spec.source_id,
        match_reason: "session_pin",
      };
      resolutions.push({ spec, matches: [pinned] });
      allMatches.push(pinned);
      continue;
    }

    const matches = await resolveSpec(spec);
    resolutions.push({ spec, matches });
    allMatches.push(...matches);
  }

  // Dedupe across specs so two refs to the same case only fetch chunks once.
  const dedupedKeys = new Set<string>();
  const deduped: IdentifierMatch[] = [];
  for (const m of allMatches) {
    const k = `${m.source_table}:${m.source_id}`;
    if (dedupedKeys.has(k)) continue;
    dedupedKeys.add(k);
    deduped.push(m);
  }

  if (deduped.length === 0) return { chunks: [], resolutions };

  const chunks = await fetchChunksForCases(deduped);
  return { chunks, resolutions };
}

async function resolveSpec(spec: IdentifierSpec): Promise<IdentifierMatch[]> {
  // 1. Citation exact match (extracted_citation preferred, legacy citation fallback).
  if (spec.citation) {
    const byCitation = await findByCitation(spec.citation);
    if (byCitation.length > 0) return byCitation;
  }

  // 2. Title / party fuzzy match.
  if (spec.title) {
    const byTitle = await findByTitleOrParty(spec.title);
    if (byTitle.length > 0) return byTitle;
  }

  return [];
}

async function findByCitation(citation: string): Promise<IdentifierMatch[]> {
  const out: IdentifierMatch[] = [];
  const cite = citation.trim();

  const scExtracted = await pool.query(
    `SELECT id FROM supreme_court_cases WHERE extracted_citation = $1 LIMIT 3`,
    [cite]
  );
  for (const r of scExtracted.rows) {
    out.push({ source_table: "supreme_court_cases", source_id: r.id as number, match_reason: "exact_citation" });
  }
  if (out.length === 0) {
    const scLegacy = await pool.query(
      `SELECT id FROM supreme_court_cases WHERE citation = $1 LIMIT 3`,
      [cite]
    );
    for (const r of scLegacy.rows) {
      out.push({ source_table: "supreme_court_cases", source_id: r.id as number, match_reason: "legacy_citation" });
    }
  }

  const hcExtracted = await pool.query(
    `SELECT id FROM high_court_cases WHERE extracted_citation = $1 LIMIT 3`,
    [cite]
  );
  for (const r of hcExtracted.rows) {
    out.push({ source_table: "high_court_cases", source_id: r.id as number, match_reason: "exact_citation" });
  }

  return out;
}

async function findByTitleOrParty(title: string): Promise<IdentifierMatch[]> {
  const term = title.trim();
  if (term.length < 3) return [];
  const pattern = `%${term}%`;
  const out: IdentifierMatch[] = [];

  const sc = await pool.query(
    `SELECT id, title
       FROM supreme_court_cases
      WHERE title ILIKE $1
         OR extracted_petitioner ILIKE $1
         OR extracted_respondent ILIKE $1
         OR petitioner ILIKE $1
         OR respondent ILIKE $1
      ORDER BY decision_date DESC NULLS LAST
      LIMIT 3`,
    [pattern]
  );
  for (const r of sc.rows) {
    out.push({ source_table: "supreme_court_cases", source_id: r.id as number, match_reason: "title_ilike" });
  }

  const hc = await pool.query(
    `SELECT id
       FROM high_court_cases
      WHERE title ILIKE $1
         OR extracted_petitioner ILIKE $1
         OR extracted_respondent ILIKE $1
      ORDER BY decision_date DESC NULLS LAST
      LIMIT 3`,
    [pattern]
  );
  for (const r of hc.rows) {
    out.push({ source_table: "high_court_cases", source_id: r.id as number, match_reason: "title_ilike" });
  }

  return out;
}

async function fetchChunksForCases(matches: IdentifierMatch[]): Promise<RetrievedChunk[]> {
  const scIds = matches
    .filter((m) => m.source_table === "supreme_court_cases")
    .map((m) => m.source_id);
  const hcIds = matches
    .filter((m) => m.source_table === "high_court_cases")
    .map((m) => m.source_id);

  const out: RetrievedChunk[] = [];

  if (scIds.length > 0) {
    const { rows } = await pool.query(
      `
      SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_index, ch.chunk_text,
             ch.paragraph_numbers,
             sc.title, sc.citation, sc.court, sc.judge, sc.decision_date::text AS decision_date,
             sc.petitioner, sc.respondent, sc.disposal_nature, sc.year, sc.path,
             sc.acts_cited, sc.judge_names, sc.keywords,
             NULL::text AS pdf_url
        FROM case_chunks ch
        JOIN supreme_court_cases sc ON ch.source_id = sc.id
       WHERE ch.source_table = 'supreme_court_cases'
         AND ch.source_id = ANY($1::int[])
       ORDER BY ch.source_id, ch.chunk_index
`,
      [scIds]
    );
    for (const r of rows) out.push(toLookupChunk(r, "supreme_court_cases"));
  }

  if (hcIds.length > 0) {
    const { rows } = await pool.query(
      `
      SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_index, ch.chunk_text,
             ch.paragraph_numbers,
             hc.title, NULL::text AS citation, hc.court_name AS court, hc.judge,
             hc.decision_date::text AS decision_date,
             NULL::text AS petitioner, NULL::text AS respondent,
             hc.disposal_nature, hc.year, NULL::text AS path, hc.pdf_url,
             hc.acts_cited, hc.judge_names, hc.keywords
        FROM case_chunks ch
        JOIN high_court_cases hc ON ch.source_id = hc.id
       WHERE ch.source_table = 'high_court_cases'
         AND ch.source_id = ANY($1::int[])
       ORDER BY ch.source_id, ch.chunk_index
`,
      [hcIds]
    );
    for (const r of rows) out.push(toLookupChunk(r, "high_court_cases"));
  }

  // Cap per case so a 300-paragraph judgment doesn't drown out others.
  return capChunksPerCase(out, MAX_CHUNKS_PER_LOOKUP_CASE);
}

function toParagraphNumbers(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out.length > 0 ? out : null;
}

function capChunksPerCase(chunks: RetrievedChunk[], cap: number): RetrievedChunk[] {
  const counts = new Map<string, number>();
  const out: RetrievedChunk[] = [];
  for (const ch of chunks) {
    const k = `${ch.source_table}:${ch.source_id}`;
    const c = counts.get(k) ?? 0;
    if (c >= cap) continue;
    counts.set(k, c + 1);
    out.push(ch);
  }
  return out;
}

function toLookupChunk(
  r: Record<string, unknown>,
  source_table: "supreme_court_cases" | "high_court_cases"
): RetrievedChunk {
  return {
    chunk_id: r.chunk_id as number,
    source_table,
    source_id: r.source_id as number,
    chunk_index: r.chunk_index as number,
    chunk_text: (r.chunk_text as string) || "",
    rrf_score: 0,
    paragraph_numbers: toParagraphNumbers(r.paragraph_numbers),
    case: {
      title: (r.title as string) || "",
      citation: (r.citation as string | null) ?? null,
      court: (r.court as string) || "",
      judge: (r.judge as string | null) ?? null,
      decision_date: (r.decision_date as string | null) ?? null,
      petitioner: (r.petitioner as string | null) ?? null,
      respondent: (r.respondent as string | null) ?? null,
      disposal_nature: (r.disposal_nature as string | null) ?? null,
      year: (r.year as number | null) ?? null,
      path: (r.path as string | null) ?? null,
      pdf_url: (r.pdf_url as string | null) ?? null,
      acts_cited: toStringArray(r.acts_cited),
      judge_names: toStringArray(r.judge_names),
      keywords: toStringArray(r.keywords),
    },
  };
}

