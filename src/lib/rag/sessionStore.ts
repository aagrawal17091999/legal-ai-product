import pool from "../db";
import { toStringArray } from "../metadata";
import type { RetrievedChunk, RetrievedCaseMeta } from "../search";
import type { CitedCase } from "@/types";

/**
 * Session-level document store.
 *
 * The chat pipeline discards retrieved chunks after each turn. For follow-ups
 * that reference prior-cited cases ("give me the paragraph numbers for those
 * propositions"), we need the original cases available without forcing a
 * fresh retrieval that might miss them.
 *
 * The store is built by walking back through recent assistant messages in the
 * same session, collecting the cases they cited (`chat_messages.cited_cases`)
 * and — when available — the exact chunk ids that were reranked into context
 * (from `rag_pipeline_steps.data.scored[].chunk_id` on the rerank step).
 *
 * Two tiers:
 *   - hot  : the most-recently-cited N cases, loaded as full RetrievedChunks
 *            so they can flow straight into contextBuilder.buildContext().
 *   - cold : every other case cited earlier in the session, kept as a thin
 *            summary (title, citation, headnotes snippet). The router sees
 *            these and can promote any of them back to hot via a fresh
 *            retrieval targeted at the case identifier.
 */

const HOT_TIER_CASE_LIMIT = 6;
const LOOKBACK_ASSISTANT_MESSAGES = 20;
const MAX_CHUNKS_PER_HOT_CASE = 16;
const MAX_CHUNKS_PER_HOT_CASE_REUSE = 150;
const COLD_HEADNOTE_CHARS = 400;

export interface SessionColdCase {
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  title: string;
  citation: string | null;
  headnotes_snippet: string | null;
}

export interface SessionCaseSummary {
  /** Order in session recency: 1 = most recently cited. */
  recency_rank: number;
  tier: "hot" | "cold";
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  title: string;
  citation: string | null;
}

export interface SessionDocumentStore {
  /** Chunks for the hot-tier cases, ready to feed into buildContext. */
  hotChunks: RetrievedChunk[];
  /** Metadata-only summaries for every other case cited earlier in the session. */
  coldCases: SessionColdCase[];
  /** Compact list of every case visible in the session — passed to the turn
   *  router so it can decide "reuse" vs "retrieve new" vs "lookup identifier". */
  caseSummaries: SessionCaseSummary[];
  /** Per-case diagnostic: how many chunks we loaded and from where. */
  trace: {
    assistant_messages_scanned: number;
    unique_cases_found: number;
    hot_cases_loaded: number;
    hot_chunks_loaded: number;
    cold_cases: number;
    used_rerank_trace: boolean;
  };
}

interface CitedCaseRow {
  message_id: string;
  cited_cases: CitedCase[] | null;
  created_at: string;
  rerank_data: { scored?: Array<{ chunk_id: number; new_rank: number }> } | null;
}

export async function hydrateSessionStore(
  sessionId: string
): Promise<SessionDocumentStore> {
  const { rows: messageRows } = await pool.query<CitedCaseRow>(
    `
    SELECT cm.id AS message_id,
           cm.cited_cases,
           cm.created_at,
           (
             SELECT data
               FROM rag_pipeline_steps
              WHERE message_id = cm.id AND step = 'rerank'
              LIMIT 1
           ) AS rerank_data
      FROM chat_messages cm
     WHERE cm.session_id = $1
       AND cm.role = 'assistant'
       AND cm.status = 'success'
     ORDER BY cm.created_at DESC
     LIMIT $2
    `,
    [sessionId, LOOKBACK_ASSISTANT_MESSAGES]
  );

  if (messageRows.length === 0) {
    return emptyStore();
  }

  // Walk messages from newest → oldest, collecting (source_table, source_id)
  // in order of first appearance. Also gather the chunk_ids each message
  // actually reranked (when the trace is available).
  const caseOrder: Array<{
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
    first_seen_message_id: string;
    title: string;
    citation: string | null;
  }> = [];
  const seenCase = new Set<string>();
  const chunkIdsPerCase = new Map<string, Set<number>>();
  let usedRerankTrace = false;

  for (const row of messageRows) {
    const cited = Array.isArray(row.cited_cases) ? row.cited_cases : [];
    const rerankChunkIds = (row.rerank_data?.scored ?? [])
      .map((s) => s.chunk_id)
      .filter((n): n is number => typeof n === "number");
    if (rerankChunkIds.length > 0) usedRerankTrace = true;

    for (const cc of cited) {
      const key = `${cc.source_table}:${cc.id}`;
      if (!seenCase.has(key)) {
        seenCase.add(key);
        caseOrder.push({
          source_table: cc.source_table,
          source_id: cc.id,
          first_seen_message_id: row.message_id,
          title: cc.title,
          citation: cc.citation,
        });
      }
      // Even for already-seen cases we track chunk_ids; the hot-tier fetch
      // below is keyed on (source_table, source_id) so we only use these
      // for ranking within the case.
      if (rerankChunkIds.length > 0) {
        const bucket = chunkIdsPerCase.get(key) ?? new Set<number>();
        for (const id of rerankChunkIds) bucket.add(id);
        chunkIdsPerCase.set(key, bucket);
      }
    }
  }

  const hotCases = caseOrder.slice(0, HOT_TIER_CASE_LIMIT);
  const coldCases = caseOrder.slice(HOT_TIER_CASE_LIMIT);

  const hotChunks = await loadHotChunks(hotCases, chunkIdsPerCase);
  const coldSummaries = await loadColdSummaries(coldCases);

  const caseSummaries: SessionCaseSummary[] = caseOrder.map((c, i) => ({
    recency_rank: i + 1,
    tier: i < HOT_TIER_CASE_LIMIT ? "hot" : "cold",
    source_table: c.source_table,
    source_id: c.source_id,
    title: c.title,
    citation: c.citation,
  }));

  return {
    hotChunks,
    coldCases: coldSummaries,
    caseSummaries,
    trace: {
      assistant_messages_scanned: messageRows.length,
      unique_cases_found: caseOrder.length,
      hot_cases_loaded: hotCases.length,
      hot_chunks_loaded: hotChunks.length,
      cold_cases: coldSummaries.length,
      used_rerank_trace: usedRerankTrace,
    },
  };
}

function emptyStore(): SessionDocumentStore {
  return {
    hotChunks: [],
    coldCases: [],
    caseSummaries: [],
    trace: {
      assistant_messages_scanned: 0,
      unique_cases_found: 0,
      hot_cases_loaded: 0,
      hot_chunks_loaded: 0,
      cold_cases: 0,
      used_rerank_trace: false,
    },
  };
}

/**
 * Fetch every chunk for a list of cases in chunk_index order. Used by both
 * loadHotChunks (which caps per case for cache compactness) and
 * loadFullChunksForHotCases (which does not, so a narrowing follow-up can
 * rerank over the whole judgment). Also used by the agent's tool layer
 * (load_case tool) to pull full judgment text on demand.
 */
export async function queryAllChunksForCases(
  cases: Array<{
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
  }>
): Promise<RetrievedChunk[]> {
  if (cases.length === 0) return [];

  const scIds: number[] = [];
  const hcIds: number[] = [];
  for (const c of cases) {
    if (c.source_table === "supreme_court_cases") scIds.push(c.source_id);
    else hcIds.push(c.source_id);
  }

  const all: RetrievedChunk[] = [];

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
    for (const r of rows) all.push(rowToChunk(r, "supreme_court_cases"));
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
    for (const r of rows) all.push(rowToChunk(r, "high_court_cases"));
  }

  return all;
}

/**
 * For each hot-tier case, load up to MAX_CHUNKS_PER_HOT_CASE chunks in chunk_index
 * order. When a rerank-trace chunk-id set is available for the case, prefer those
 * exact chunks (so the follow-up sees the *same* passages the prior answer did).
 */
async function loadHotChunks(
  cases: Array<{
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
  }>,
  chunkIdsPerCase: Map<string, Set<number>>
): Promise<RetrievedChunk[]> {
  const all = await queryAllChunksForCases(cases);

  // Group by case, then pick top N per case preferring previously reranked chunks.
  const byCase = new Map<string, RetrievedChunk[]>();
  for (const ch of all) {
    const k = `${ch.source_table}:${ch.source_id}`;
    const bucket = byCase.get(k) ?? [];
    bucket.push(ch);
    byCase.set(k, bucket);
  }

  const picked: RetrievedChunk[] = [];
  // Preserve the input case order (recency).
  for (const c of cases) {
    const k = `${c.source_table}:${c.source_id}`;
    const chunks = byCase.get(k) ?? [];
    const preferredIds = chunkIdsPerCase.get(k);
    const ranked = [...chunks].sort((a, b) => {
      const aPref = preferredIds?.has(a.chunk_id) ? 0 : 1;
      const bPref = preferredIds?.has(b.chunk_id) ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.chunk_index - b.chunk_index;
    });
    picked.push(...ranked.slice(0, MAX_CHUNKS_PER_HOT_CASE));
  }

  return picked;
}

/**
 * Load every chunk for each hot-tier case in the session (up to
 * MAX_CHUNKS_PER_HOT_CASE_REUSE per case to keep Voyage rerank payload bounded).
 *
 * Used by the reuse_session branch when the follow-up narrows to a *new aspect*
 * of a loaded case — the cached hot chunks were biased to whatever the previous
 * turn reranked, so a fresh rerank over the full judgment is what surfaces
 * previously-unseen paragraphs (arguments, submissions, disposal, etc.).
 */
export async function loadFullChunksForHotCases(
  store: SessionDocumentStore
): Promise<RetrievedChunk[]> {
  const hotCases = store.caseSummaries
    .filter((c) => c.tier === "hot")
    .map((c) => ({ source_table: c.source_table, source_id: c.source_id }));

  const all = await queryAllChunksForCases(hotCases);

  // Cap per case so total payload stays under Voyage's 1000-doc rerank limit
  // even with 6 hot cases of a long judgment.
  const byCase = new Map<string, RetrievedChunk[]>();
  for (const ch of all) {
    const k = `${ch.source_table}:${ch.source_id}`;
    const bucket = byCase.get(k) ?? [];
    bucket.push(ch);
    byCase.set(k, bucket);
  }
  const out: RetrievedChunk[] = [];
  for (const c of hotCases) {
    const k = `${c.source_table}:${c.source_id}`;
    const chunks = byCase.get(k) ?? [];
    out.push(...chunks.slice(0, MAX_CHUNKS_PER_HOT_CASE_REUSE));
  }
  return out;
}

async function loadColdSummaries(
  cases: Array<{
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
    title: string;
    citation: string | null;
  }>
): Promise<SessionColdCase[]> {
  if (cases.length === 0) return [];

  const scIds = cases.filter((c) => c.source_table === "supreme_court_cases").map((c) => c.source_id);
  const hcIds = cases.filter((c) => c.source_table === "high_court_cases").map((c) => c.source_id);

  const headnotesMap = new Map<string, string | null>();

  if (scIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, headnotes FROM supreme_court_cases WHERE id = ANY($1::int[])`,
      [scIds]
    );
    for (const r of rows) {
      headnotesMap.set(`supreme_court_cases:${r.id}`, snippet(r.headnotes));
    }
  }
  if (hcIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, headnotes FROM high_court_cases WHERE id = ANY($1::int[])`,
      [hcIds]
    );
    for (const r of rows) {
      headnotesMap.set(`high_court_cases:${r.id}`, snippet(r.headnotes));
    }
  }

  return cases.map((c) => ({
    source_table: c.source_table,
    source_id: c.source_id,
    title: c.title,
    citation: c.citation,
    headnotes_snippet: headnotesMap.get(`${c.source_table}:${c.source_id}`) ?? null,
  }));
}

function snippet(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > COLD_HEADNOTE_CHARS
    ? trimmed.slice(0, COLD_HEADNOTE_CHARS) + "…"
    : trimmed;
}

function rowToChunk(
  r: Record<string, unknown>,
  source_table: "supreme_court_cases" | "high_court_cases"
): RetrievedChunk {
  const meta: RetrievedCaseMeta = {
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
  };
  return {
    chunk_id: r.chunk_id as number,
    source_table,
    source_id: r.source_id as number,
    chunk_index: r.chunk_index as number,
    chunk_text: (r.chunk_text as string) || "",
    rrf_score: 0, // session-store chunks aren't RRF-scored; populated 0 for type compat.
    paragraph_numbers: normalizeParagraphNumbers(r.paragraph_numbers),
    case: meta,
  };
}

function normalizeParagraphNumbers(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out.length > 0 ? out : null;
}

/**
 * Render the session summary as a compact string for the turn router's prompt.
 * Shape (one per line):
 *   [rank, tier] Title — Citation (source_table:id)
 */
export function renderCaseSummariesForRouter(
  summaries: SessionCaseSummary[]
): string {
  if (summaries.length === 0) return "(no cases cited yet in this session)";
  return summaries
    .map((s) => {
      const cite = s.citation ? ` — ${s.citation}` : "";
      return `[${s.recency_rank}, ${s.tier}] ${s.title}${cite} (${s.source_table}:${s.source_id})`;
    })
    .join("\n");
}
