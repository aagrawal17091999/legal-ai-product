import { NextRequest, NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import pool from "@/lib/db";
import { buildFilterClauses } from "@/lib/search";
import { logError } from "@/lib/error-logger";
import type { SearchFilters, JudgmentSearchResponse, FilterDiagnostic } from "@/types";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function parseFilters(params: URLSearchParams): SearchFilters {
  const filters: SearchFilters = {};
  const court = params.get("court");
  const yearFrom = params.get("yearFrom");
  const yearTo = params.get("yearTo");
  const citation = params.get("citation");
  const extractedPetitioner = params.get("extractedPetitioner");
  const extractedRespondent = params.get("extractedRespondent");
  const caseCategory = params.get("caseCategory");
  const caseNumber = params.get("caseNumber");
  const judgeName = params.get("judgeName");
  const actCited = params.get("actCited");
  const keyword = params.get("keyword");

  if (court) filters.court = court;
  if (yearFrom) filters.yearFrom = parseInt(yearFrom);
  if (yearTo) filters.yearTo = parseInt(yearTo);
  if (citation) filters.citation = citation;
  if (extractedPetitioner) filters.extractedPetitioner = extractedPetitioner;
  if (extractedRespondent) filters.extractedRespondent = extractedRespondent;
  if (caseCategory) filters.caseCategory = caseCategory;
  if (caseNumber) filters.caseNumber = caseNumber;
  if (judgeName) filters.judgeName = judgeName;
  if (actCited) filters.actCited = actCited;
  if (keyword) filters.keyword = keyword;
  return filters;
}

function hasAnyFilter(filters: SearchFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined && v !== "");
}

const FILTER_LABELS: Record<string, string> = {
  court: "Court",
  yearFrom: "Year From",
  yearTo: "Year To",
  citation: "Citation",
  extractedPetitioner: "Petitioner",
  extractedRespondent: "Respondent",
  caseCategory: "Case Category",
  caseNumber: "Case Number",
  judgeName: "Judge Name",
  actCited: "Acts Cited",
  keyword: "Keyword",
};

function buildCountQuery(
  filters: SearchFilters
): { query: string; params: unknown[] } {
  const searchSC = !filters.court || filters.court === "Supreme Court of India";
  const searchHC = !filters.court || filters.court !== "Supreme Court of India";

  const { filterClauses: scClauses, filterParams: scParams } = buildFilterClauses(filters, "sc");
  const { filterClauses: hcClauses, filterParams: hcParams } = buildFilterClauses(filters, "hc");

  const countParts: string[] = [];
  let allParams: unknown[] = [];
  let paramOffset = 0;

  if (searchSC) {
    const scReindexed = scClauses.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + paramOffset}`);
    countParts.push(`SELECT COUNT(*) AS cnt FROM supreme_court_cases WHERE 1=1 ${scReindexed}`);
    allParams = [...allParams, ...scParams];
    paramOffset += scParams.length;
  }

  if (searchHC) {
    const hcReindexed = hcClauses.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + paramOffset}`);
    countParts.push(`SELECT COUNT(*) AS cnt FROM high_court_cases WHERE 1=1 ${hcReindexed}`);
    allParams = [...allParams, ...hcParams];
  }

  const query = `SELECT ${countParts.map((p, i) => `(${p}) AS c${i}`).join(", ")}`;
  return { query, params: allParams };
}

function sumCountRow(row: Record<string, string>): number {
  let total = 0;
  for (const key of Object.keys(row)) {
    total += parseInt(row[key]) || 0;
  }
  return total;
}

async function buildDiagnostics(filters: SearchFilters): Promise<FilterDiagnostic[]> {
  const activeKeys = Object.keys(filters).filter(
    (k) => filters[k as keyof SearchFilters] !== undefined && filters[k as keyof SearchFilters] !== ""
  );

  if (activeKeys.length <= 1) return [];

  const diagnostics: FilterDiagnostic[] = [];

  await Promise.all(
    activeKeys.map(async (key) => {
      const singleFilter: SearchFilters = { [key]: filters[key as keyof SearchFilters] };
      // Preserve court for table selection logic
      if (key !== "court" && filters.court) {
        singleFilter.court = filters.court;
      }
      const { query, params } = buildCountQuery(singleFilter);
      const result = await pool.query(query, params);
      diagnostics.push({
        filterName: FILTER_LABELS[key] || key,
        filterValue: String(filters[key as keyof SearchFilters]),
        count: sumCountRow(result.rows[0]),
      });
    })
  );

  return diagnostics.sort((a, b) => a.count - b.count);
}

// GET /api/judgments/search?court=...&yearFrom=...&page=1&limit=20
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const filters = parseFilters(params);
  const countOnly = params.get("countOnly") === "true";
  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(params.get("limit") || String(DEFAULT_LIMIT))));
  const offset = (page - 1) * limit;

  if (!hasAnyFilter(filters)) {
    return NextResponse.json(
      { error: "Please select at least one filter to search." },
      { status: 400 }
    );
  }

  try {
    // Count-only mode: return just the total for live preview
    if (countOnly) {
      const { query, params: countParams } = buildCountQuery(filters);
      const countResult = await pool.query(query, countParams);
      const total = sumCountRow(countResult.rows[0]);
      return NextResponse.json({ results: [], total, page: 1, limit });
    }

    const searchSC = !filters.court || filters.court === "Supreme Court of India";
    const searchHC = !filters.court || filters.court !== "Supreme Court of India";

    const { filterClauses: scClauses, filterParams: scParams } = buildFilterClauses(filters, "sc");
    const { filterClauses: hcClauses, filterParams: hcParams } = buildFilterClauses(filters, "hc");

    // Build UNION ALL query parts
    const unionParts: string[] = [];
    const countParts: string[] = [];
    let allParams: unknown[] = [];
    let paramOffset = 0;

    if (searchSC) {
      // Reindex SC params
      const scReindexed = scClauses.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + paramOffset}`);
      unionParts.push(`
        SELECT id, 'supreme_court_cases' AS source_table,
               title, extracted_citation AS citation,
               extracted_petitioner AS petitioner, extracted_respondent AS respondent,
               decision_date::text, court, case_category, year,
               (path IS NOT NULL) AS has_pdf
        FROM supreme_court_cases
        WHERE 1=1 ${scReindexed}
      `);
      countParts.push(`
        SELECT COUNT(*) AS cnt FROM supreme_court_cases WHERE 1=1 ${scReindexed}
      `);
      allParams = [...allParams, ...scParams];
      paramOffset += scParams.length;
    }

    if (searchHC) {
      // Reindex HC params
      const hcReindexed = hcClauses.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + paramOffset}`);
      unionParts.push(`
        SELECT id, 'high_court_cases' AS source_table,
               title, extracted_citation AS citation,
               NULL AS petitioner, NULL AS respondent,
               decision_date::text, court_name AS court, case_category, year,
               (pdf_url IS NOT NULL OR pdf_link IS NOT NULL) AS has_pdf
        FROM high_court_cases
        WHERE 1=1 ${hcReindexed}
      `);
      countParts.push(`
        SELECT COUNT(*) AS cnt FROM high_court_cases WHERE 1=1 ${hcReindexed}
      `);
      allParams = [...allParams, ...hcParams];
      paramOffset += hcParams.length;
    }

    // Run count and data queries in parallel
    const unionQuery = `
      ${unionParts.join(" UNION ALL ")}
      ORDER BY decision_date DESC NULLS LAST
      LIMIT $${paramOffset + 1} OFFSET $${paramOffset + 2}
    `;

    // For the count query, we need to duplicate params for each part
    const countQuery = `SELECT ${countParts.map((p, i) => `(${p}) AS c${i}`).join(", ")}`;

    // Build count params: SC params + HC params (same as allParams minus limit/offset)
    const countParams = searchSC && searchHC
      ? [...scParams, ...hcParams]
      : searchSC
        ? [...scParams]
        : [...hcParams];

    const [dataResult, countResult] = await Promise.all([
      pool.query(unionQuery, [...allParams, limit, offset]),
      pool.query(countQuery, countParams),
    ]);

    // Sum up counts from all parts
    const total = sumCountRow(countResult.rows[0]);

    const response: JudgmentSearchResponse = {
      results: dataResult.rows.map((r) => ({
        id: r.id,
        source_table: r.source_table,
        title: r.title || "",
        citation: r.citation,
        petitioner: r.petitioner,
        respondent: r.respondent,
        decision_date: r.decision_date,
        court: r.court || "",
        case_category: r.case_category,
        year: r.year,
        has_pdf: r.has_pdf,
      })),
      total,
      page,
      limit,
    };

    // When 0 results with multiple filters, add per-filter diagnostics
    if (total === 0) {
      response.diagnostics = await buildDiagnostics(filters);
    }

    return NextResponse.json(response);
  } catch (err) {
    logError({
      category: "search",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/judgments/search",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
