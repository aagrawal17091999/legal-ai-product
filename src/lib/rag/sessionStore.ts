import pool from "../db";
import { toStringArray } from "../metadata";
import type { RetrievedChunk, RetrievedCaseMeta } from "../search";
import type { CitedCase } from "@/types";

/**
 * Session-level document store.
 *
 * The chat pipeline discards retrieved chunks after each turn. For follow-ups
 * that reference prior-cited cases, the agent needs to know what is already in
 * the conversation so it can decide between reusing a loaded case (load_case)
 * and searching the whole database (search_fresh).
 *
 * This store walks back through recent assistant messages, collects the cases
 * they cited (`chat_messages.cited_cases`), and enriches each with enough
 * content — the issue under consideration, a headnotes snippet, the acts cited —
 * for the agent to judge whether a follow-up is *covered* by an already-loaded
 * case (→ load_case) or genuinely new (→ search_fresh). Titles alone aren't
 * enough for that judgment, which is what pushed the agent toward re-searching
 * the same topic and surfacing fresh, unrelated cases.
 *
 * Full chunk text is NOT preloaded here: the load_case tool fetches the whole
 * judgment on demand (queryAllChunksForCases) and reranks it by aspect, which
 * supersedes the old hot/cold chunk cache.
 */

const LOOKBACK_ASSISTANT_MESSAGES = 20;
const HEADNOTE_SNIPPET_CHARS = 400;
const ISSUE_SNIPPET_CHARS = 600;

export interface SessionCaseSummary {
  /** Order in session recency: 1 = most recently cited. */
  recency_rank: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  title: string;
  citation: string | null;
  /** Issue(s) for consideration — the strongest signal of what the case covers. */
  issue: string | null;
  /** Short headnotes excerpt, for the agent to gauge subject matter. */
  headnotes_snippet: string | null;
  /** Statutes/acts the case turns on — helps match statute-anchored follow-ups. */
  acts_cited: string[];
}

export interface SessionDocumentStore {
  /** Every case cited earlier in the session, recency-ordered, with content
   *  signals so the agent can decide reuse-vs-research. */
  caseSummaries: SessionCaseSummary[];
  /** Diagnostics for the audit log. */
  trace: {
    assistant_messages_scanned: number;
    unique_cases_found: number;
    cases_enriched: number;
  };
}

interface CitedCaseRow {
  message_id: string;
  cited_cases: CitedCase[] | null;
  created_at: string;
}

interface CaseMetaRow {
  issue: string | null;
  headnotes_snippet: string | null;
  acts_cited: string[];
}

export async function hydrateSessionStore(
  sessionId: string
): Promise<SessionDocumentStore> {
  const { rows: messageRows } = await pool.query<CitedCaseRow>(
    `
    SELECT cm.id AS message_id,
           cm.cited_cases,
           cm.created_at
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

  // Walk messages newest → oldest, collecting cases in order of first appearance.
  const caseOrder: Array<{
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
    title: string;
    citation: string | null;
  }> = [];
  const seenCase = new Set<string>();

  for (const row of messageRows) {
    const cited = Array.isArray(row.cited_cases) ? row.cited_cases : [];
    for (const cc of cited) {
      const key = `${cc.source_table}:${cc.id}`;
      if (seenCase.has(key)) continue;
      seenCase.add(key);
      caseOrder.push({
        source_table: cc.source_table,
        source_id: cc.id,
        title: cc.title,
        citation: cc.citation,
      });
    }
  }

  const metaByKey = await loadCaseMeta(caseOrder);

  const caseSummaries: SessionCaseSummary[] = caseOrder.map((c, i) => {
    const meta = metaByKey.get(`${c.source_table}:${c.source_id}`);
    return {
      recency_rank: i + 1,
      source_table: c.source_table,
      source_id: c.source_id,
      title: c.title,
      citation: c.citation,
      issue: meta?.issue ?? null,
      headnotes_snippet: meta?.headnotes_snippet ?? null,
      acts_cited: meta?.acts_cited ?? [],
    };
  });

  return {
    caseSummaries,
    trace: {
      assistant_messages_scanned: messageRows.length,
      unique_cases_found: caseOrder.length,
      cases_enriched: metaByKey.size,
    },
  };
}

function emptyStore(): SessionDocumentStore {
  return {
    caseSummaries: [],
    trace: {
      assistant_messages_scanned: 0,
      unique_cases_found: 0,
      cases_enriched: 0,
    },
  };
}

/**
 * Batch-fetch issue / headnotes / acts for every session case (one query per
 * table). Keyed `source_table:source_id`.
 */
async function loadCaseMeta(
  cases: Array<{
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
  }>
): Promise<Map<string, CaseMetaRow>> {
  const out = new Map<string, CaseMetaRow>();
  if (cases.length === 0) return out;

  const scIds = cases.filter((c) => c.source_table === "supreme_court_cases").map((c) => c.source_id);
  const hcIds = cases.filter((c) => c.source_table === "high_court_cases").map((c) => c.source_id);

  if (scIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, issue_for_consideration, headnotes, acts_cited
         FROM supreme_court_cases WHERE id = ANY($1::int[])`,
      [scIds]
    );
    for (const r of rows) {
      out.set(`supreme_court_cases:${r.id}`, rowToMeta(r));
    }
  }
  if (hcIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, issue_for_consideration, headnotes, acts_cited
         FROM high_court_cases WHERE id = ANY($1::int[])`,
      [hcIds]
    );
    for (const r of rows) {
      out.set(`high_court_cases:${r.id}`, rowToMeta(r));
    }
  }

  return out;
}

function rowToMeta(r: Record<string, unknown>): CaseMetaRow {
  // acts_cited may be an array of strings or of objects with a `name` field.
  let acts: string[] = [];
  const rawActs = r.acts_cited;
  if (Array.isArray(rawActs)) {
    acts = rawActs
      .map((a) =>
        typeof a === "string"
          ? a
          : a && typeof a === "object" && "name" in a
          ? String((a as Record<string, unknown>).name)
          : ""
      )
      .filter((s) => s.length > 0);
  } else {
    acts = toStringArray(rawActs);
  }
  return {
    issue: snippet(r.issue_for_consideration, ISSUE_SNIPPET_CHARS),
    headnotes_snippet: snippet(r.headnotes, HEADNOTE_SNIPPET_CHARS),
    acts_cited: acts,
  };
}

/**
 * Fetch every chunk for a list of cases in chunk_index order. Used by the
 * agent's load_case tool to pull full judgment text on demand.
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

export interface CitedCaseRef {
  name: string;
  citation: string | null;
}

/**
 * Parse the `cases_cited` JSONB column (array of {name, citation}) into a clean
 * list. Exported for unit testing. Tolerant of strings, missing fields, and
 * malformed entries.
 */
export function parseCitedCases(value: unknown): CitedCaseRef[] {
  if (!Array.isArray(value)) return [];
  const out: CitedCaseRef[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    let name = "";
    let citation: string | null = null;
    if (typeof v === "string") {
      name = v.trim();
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      name = typeof o.name === "string" ? o.name.trim() : "";
      citation = typeof o.citation === "string" && o.citation.trim() ? o.citation.trim() : null;
    }
    if (!name && !citation) continue;
    const key = `${name.toLowerCase()}|${(citation ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, citation });
  }
  return out;
}

/**
 * Fetch the cases a given judgment cites (from the `cases_cited` column). Used by
 * the citation-graph tool to find the authorities a loaded case relies on.
 */
export async function queryCitedCases(
  source_table: "supreme_court_cases" | "high_court_cases",
  source_id: number
): Promise<CitedCaseRef[]> {
  const table =
    source_table === "supreme_court_cases" ? "supreme_court_cases" : "high_court_cases";
  const { rows } = await pool.query(
    `SELECT cases_cited FROM ${table} WHERE id = $1`,
    [source_id]
  );
  if (rows.length === 0) return [];
  return parseCitedCases(rows[0].cases_cited);
}

function snippet(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) + "…" : trimmed;
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
