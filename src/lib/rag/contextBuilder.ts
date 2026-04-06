import pool from "../db";
import { getSignedPdfUrl } from "../r2";
import type { RetrievedChunk, RetrievedCaseMeta } from "../search";
import type { CitedCase } from "@/types";

/**
 * Group reranked chunks back into cases, fetch structured extraction metadata
 * (headnotes, issue_for_consideration, acts_cited, extracted_citation, ...),
 * and format everything into the context string that is handed to Claude.
 *
 * Design choices:
 * - Chunks for the same case are sorted by chunk_index and merged into one
 *   contiguous excerpt per case. This gives the LLM narrative flow instead of
 *   disjointed fragments.
 * - A token budget prevents one long judgment from crowding out the others.
 * - Each case is assigned a 1-based index that the system prompt instructs
 *   Claude to cite as [^1], [^2], etc. The same index is returned to the
 *   frontend on the `cases` event so inline citations can be resolved.
 */

export interface AssembledContext {
  /** The full SEARCH RESULTS string to splice into the user turn for Claude. */
  contextString: string;
  /** One entry per case, index-aligned with the [^n] citations used in the prompt. */
  cases: AssembledCase[];
  /** Per-case build-time stats for the audit log (rag_pipeline_steps). */
  trace: ContextBuildTrace;
}

export interface ContextBuildTrace {
  reranked_chunks_in: number;
  cases_candidate: number; // distinct (source_table, source_id) after grouping
  cases_used: number;      // survived the char budget
  cases_dropped_budget: number;
  total_chars: number;
  per_case: Array<{
    index: number;
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
    chunk_count: number;
    chunk_indices: number[];
    chars: number;
    extraction_present: boolean;
    pdf_signed: boolean;
  }>;
  extraction_missing_for: Array<{
    source_table: "supreme_court_cases" | "high_court_cases";
    source_id: number;
  }>;
}

export interface AssembledCase {
  index: number; // 1-based — matches the [^n] footnote in the prompt
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  meta: RetrievedCaseMeta;
  extraction: ExtractionMeta;
  pdf_url: string | null;
  pdf_path: string | null;
  /** chunk indices contributed to this case's excerpt, for tracing */
  chunk_indices: number[];
}

export interface ExtractionMeta {
  extracted_citation: string | null;
  headnotes: string | null;
  issue_for_consideration: string | null;
  acts_cited: string[];
  author_judge_name: string | null;
  bench_size: number | null;
  result_of_case: string | null;
}

// Rough 4 chars/token heuristic. Claude Sonnet accepts 200k tokens, so 60k
// characters of context is well within budget but leaves room for the rest
// of the system prompt, conversation history, and the answer.
const TOTAL_CONTEXT_CHAR_BUDGET = 60_000;
const PER_CASE_CHAR_BUDGET = 12_000;

export async function buildContext(
  rerankedChunks: RetrievedChunk[]
): Promise<AssembledContext> {
  if (rerankedChunks.length === 0) {
    return {
      contextString: "No relevant cases were found for this query.",
      cases: [],
      trace: {
        reranked_chunks_in: 0,
        cases_candidate: 0,
        cases_used: 0,
        cases_dropped_budget: 0,
        total_chars: 0,
        per_case: [],
        extraction_missing_for: [],
      },
    };
  }

  // Group chunks by case while preserving the order from the reranker
  // (best chunk first => that case's overall position).
  const grouped = new Map<
    string,
    {
      source_table: "supreme_court_cases" | "high_court_cases";
      source_id: number;
      meta: RetrievedCaseMeta;
      chunks: RetrievedChunk[];
      firstSeenRank: number;
    }
  >();

  rerankedChunks.forEach((ch, rank) => {
    const key = `${ch.source_table}:${ch.source_id}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.chunks.push(ch);
    } else {
      grouped.set(key, {
        source_table: ch.source_table,
        source_id: ch.source_id,
        meta: ch.case,
        chunks: [ch],
        firstSeenRank: rank,
      });
    }
  });

  // Sort cases by their best chunk's rank, then sort each case's chunks by chunk_index.
  const caseList = Array.from(grouped.values())
    .sort((a, b) => a.firstSeenRank - b.firstSeenRank)
    .map((c) => ({
      ...c,
      chunks: [...c.chunks].sort((a, b) => a.chunk_index - b.chunk_index),
    }));

  // Fetch extraction metadata for each (source_table, source_id) pair in two batched queries.
  const extractionBySourceKey = await fetchExtractionMeta(caseList);

  const assembled: AssembledCase[] = [];
  const caseBlocks: string[] = [];
  const perCaseTrace: ContextBuildTrace["per_case"] = [];
  const missingExtraction: ContextBuildTrace["extraction_missing_for"] = [];
  let totalChars = 0;
  let droppedByBudget = 0;

  for (let i = 0; i < caseList.length; i++) {
    const c = caseList[i];
    const extractionKey = `${c.source_table}:${c.source_id}`;
    const rawExtraction = extractionBySourceKey.get(extractionKey);
    const extraction = rawExtraction ?? emptyExtraction();
    const extractionPresent = Boolean(rawExtraction);
    if (!extractionPresent) {
      missingExtraction.push({ source_table: c.source_table, source_id: c.source_id });
    }

    const merged = mergeChunks(c.chunks, PER_CASE_CHAR_BUDGET);
    const caseBlock = formatCaseBlock(assembled.length + 1, c.meta, extraction, merged);

    if (totalChars + caseBlock.length > TOTAL_CONTEXT_CHAR_BUDGET && assembled.length > 0) {
      // Budget exhausted — stop adding cases. Having 6 fully-grounded cases
      // is better than 12 cases each with a truncated excerpt.
      droppedByBudget = caseList.length - assembled.length;
      break;
    }

    // Resolve PDF URL. SC needs presigning; HC already has direct URLs.
    let pdf_url: string | null = c.meta.pdf_url;
    let pdf_path: string | null = null;
    let pdfSigned = false;
    if (c.source_table === "supreme_court_cases" && c.meta.path && c.meta.year) {
      pdf_path = `supreme-court/${c.meta.year}/${c.meta.path}.pdf`;
      try {
        pdf_url = await getSignedPdfUrl(pdf_path);
        pdfSigned = true;
      } catch {
        // Non-fatal; keep any existing pdf_url.
      }
    }

    const caseIndex = assembled.length + 1;
    assembled.push({
      index: caseIndex,
      source_table: c.source_table,
      source_id: c.source_id,
      meta: c.meta,
      extraction,
      pdf_url,
      pdf_path,
      chunk_indices: c.chunks.map((ch) => ch.chunk_index),
    });
    caseBlocks.push(caseBlock);
    perCaseTrace.push({
      index: caseIndex,
      source_table: c.source_table,
      source_id: c.source_id,
      chunk_count: c.chunks.length,
      chunk_indices: c.chunks.map((ch) => ch.chunk_index),
      chars: caseBlock.length,
      extraction_present: extractionPresent,
      pdf_signed: pdfSigned,
    });
    totalChars += caseBlock.length;
  }

  const trace: ContextBuildTrace = {
    reranked_chunks_in: rerankedChunks.length,
    cases_candidate: caseList.length,
    cases_used: assembled.length,
    cases_dropped_budget: droppedByBudget,
    total_chars: totalChars,
    per_case: perCaseTrace,
    extraction_missing_for: missingExtraction,
  };

  return { contextString: caseBlocks.join("\n\n"), cases: assembled, trace };
}

/**
 * Convert an assembled case list into the CitedCase[] shape the frontend /
 * DB persistence layer expects.
 */
export function toCitedCases(cases: AssembledCase[]): CitedCase[] {
  return cases.map((c) => ({
    id: c.source_id,
    source_table: c.source_table,
    title: c.meta.title,
    citation: c.extraction.extracted_citation ?? c.meta.citation,
    pdf_url: c.pdf_url,
    pdf_path: c.pdf_path,
  }));
}

/**
 * Batch-fetch extraction metadata for every (source_table, source_id)
 * in the assembled case list. Two queries total (one per table).
 */
async function fetchExtractionMeta(
  cases: { source_table: "supreme_court_cases" | "high_court_cases"; source_id: number }[]
): Promise<Map<string, ExtractionMeta>> {
  const scIds = cases
    .filter((c) => c.source_table === "supreme_court_cases")
    .map((c) => c.source_id);
  const hcIds = cases
    .filter((c) => c.source_table === "high_court_cases")
    .map((c) => c.source_id);

  const out = new Map<string, ExtractionMeta>();

  if (scIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, extracted_citation, headnotes, issue_for_consideration,
              acts_cited, author_judge_name, bench_size, result_of_case
         FROM supreme_court_cases
        WHERE id = ANY($1::int[])`,
      [scIds]
    );
    for (const r of rows) {
      out.set(`supreme_court_cases:${r.id}`, rowToExtraction(r));
    }
  }

  if (hcIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, extracted_citation, headnotes, issue_for_consideration,
              acts_cited, author_judge_name, bench_size, result_of_case
         FROM high_court_cases
        WHERE id = ANY($1::int[])`,
      [hcIds]
    );
    for (const r of rows) {
      out.set(`high_court_cases:${r.id}`, rowToExtraction(r));
    }
  }

  return out;
}

function rowToExtraction(r: Record<string, unknown>): ExtractionMeta {
  const rawActs = r.acts_cited;
  let acts: string[] = [];
  if (Array.isArray(rawActs)) {
    acts = rawActs
      .map((a) => (typeof a === "string" ? a : typeof a === "object" && a && "name" in a ? String((a as Record<string, unknown>).name) : ""))
      .filter((s) => s.length > 0);
  }
  return {
    extracted_citation: (r.extracted_citation as string | null) ?? null,
    headnotes: (r.headnotes as string | null) ?? null,
    issue_for_consideration: (r.issue_for_consideration as string | null) ?? null,
    acts_cited: acts,
    author_judge_name: (r.author_judge_name as string | null) ?? null,
    bench_size: (r.bench_size as number | null) ?? null,
    result_of_case: (r.result_of_case as string | null) ?? null,
  };
}

function emptyExtraction(): ExtractionMeta {
  return {
    extracted_citation: null,
    headnotes: null,
    issue_for_consideration: null,
    acts_cited: [],
    author_judge_name: null,
    bench_size: null,
    result_of_case: null,
  };
}

/**
 * Merge a set of chunks (already sorted by chunk_index) into one readable
 * excerpt. Adjacent chunks are joined without a separator so overlap is
 * preserved readably; non-adjacent chunks get an ellipsis separator so the
 * LLM can see the gap.
 */
function mergeChunks(chunks: RetrievedChunk[], charBudget: number): string {
  if (chunks.length === 0) return "";
  const parts: string[] = [];
  let used = 0;
  let prevIdx: number | null = null;

  for (const ch of chunks) {
    if (used >= charBudget) break;
    const remaining = charBudget - used;
    const text = ch.chunk_text.length > remaining ? ch.chunk_text.slice(0, remaining) : ch.chunk_text;
    if (prevIdx !== null && ch.chunk_index !== prevIdx + 1) {
      parts.push("\n[...]\n");
      used += 6;
    }
    parts.push(text);
    used += text.length;
    prevIdx = ch.chunk_index;
  }
  return parts.join("");
}

function formatCaseBlock(
  index: number,
  meta: RetrievedCaseMeta,
  extraction: ExtractionMeta,
  excerpt: string
): string {
  const lines: string[] = [`--- Case [${index}] ---`];
  lines.push(`Title: ${meta.title || "(untitled)"}`);
  const citation = extraction.extracted_citation ?? meta.citation;
  if (citation) lines.push(`Citation: ${citation}`);
  if (meta.court) lines.push(`Court: ${meta.court}`);
  if (meta.decision_date) lines.push(`Date: ${meta.decision_date}`);
  const judge = extraction.author_judge_name ?? meta.judge;
  if (judge) lines.push(`Judge: ${judge}`);
  if (typeof extraction.bench_size === "number") {
    lines.push(`Bench size: ${extraction.bench_size}`);
  }
  if (meta.petitioner && meta.respondent) {
    lines.push(`Parties: ${meta.petitioner} v. ${meta.respondent}`);
  }
  if (meta.disposal_nature) lines.push(`Disposal: ${meta.disposal_nature}`);
  if (extraction.result_of_case) lines.push(`Result: ${extraction.result_of_case}`);
  if (extraction.acts_cited.length > 0) {
    lines.push(`Acts cited: ${extraction.acts_cited.slice(0, 8).join("; ")}`);
  }
  if (extraction.issue_for_consideration) {
    lines.push(`\nIssue for consideration:\n${extraction.issue_for_consideration.trim()}`);
  }
  if (extraction.headnotes) {
    // Headnotes can be long — cap to 1500 chars inside the per-case budget.
    const h = extraction.headnotes.trim();
    lines.push(`\nHeadnotes:\n${h.length > 1500 ? h.slice(0, 1500) + "..." : h}`);
  }
  if (excerpt) {
    lines.push(`\nRelevant Excerpt:\n${excerpt}`);
  }
  return lines.join("\n");
}
