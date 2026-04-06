import { NextResponse } from "next/server";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import type { FilterOptions } from "@/types";

// Cache filter options for 24 hours
let cachedOptions: FilterOptions | null = null;
let cacheTime = 0;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

export async function GET() {
  const now = Date.now();
  if (cachedOptions && now - cacheTime < CACHE_DURATION) {
    return NextResponse.json(cachedOptions);
  }

  try {
    // Get distinct courts
    const { rows: scCourts } = await pool.query(
      `SELECT DISTINCT court FROM supreme_court_cases WHERE court IS NOT NULL ORDER BY court`
    );
    const { rows: hcCourts } = await pool.query(
      `SELECT DISTINCT court_name FROM high_court_cases WHERE court_name IS NOT NULL ORDER BY court_name`
    );

    const courts = [
      ...scCourts.map((r) => r.court),
      ...hcCourts.map((r) => r.court_name),
    ].filter((v, i, a) => a.indexOf(v) === i);

    // Get year range
    const { rows: yearRange } = await pool.query(`
      SELECT
        LEAST(
          (SELECT MIN(year) FROM supreme_court_cases WHERE year IS NOT NULL),
          (SELECT MIN(year) FROM high_court_cases WHERE year IS NOT NULL)
        ) as min_year,
        GREATEST(
          (SELECT MAX(year) FROM supreme_court_cases WHERE year IS NOT NULL),
          (SELECT MAX(year) FROM high_court_cases WHERE year IS NOT NULL)
        ) as max_year
    `);

    // Fetch distinct values for extraction-based filters
    const textFields = [
      { column: "extracted_citation", key: "citations" },
      { column: "extracted_petitioner", key: "extractedPetitioners" },
      { column: "extracted_respondent", key: "extractedRespondents" },
      { column: "case_category", key: "caseCategories" },
      { column: "case_number", key: "caseNumbers" },
    ] as const;

    const jsonbFields = [
      { column: "judge_names", key: "judgeNames" },
      { column: "acts_cited", key: "actsCited" },
      { column: "keywords", key: "keywords" },
    ] as const;

    // Run all queries in parallel
    const textQueries = textFields.flatMap(({ column }) => [
      pool.query(
        `SELECT DISTINCT ${column} AS value FROM supreme_court_cases WHERE ${column} IS NOT NULL AND ${column} != '' ORDER BY value LIMIT 5000`
      ),
      pool.query(
        `SELECT DISTINCT ${column} AS value FROM high_court_cases WHERE ${column} IS NOT NULL AND ${column} != '' ORDER BY value LIMIT 5000`
      ),
    ]);

    const jsonbQueries = jsonbFields.flatMap(({ column }) => [
      pool.query(
        `SELECT DISTINCT jsonb_array_elements_text(${column}) AS value FROM supreme_court_cases WHERE ${column} IS NOT NULL AND ${column} != '[]'::jsonb ORDER BY value LIMIT 5000`
      ),
      pool.query(
        `SELECT DISTINCT jsonb_array_elements_text(${column}) AS value FROM high_court_cases WHERE ${column} IS NOT NULL AND ${column} != '[]'::jsonb ORDER BY value LIMIT 5000`
      ),
    ]);

    const allResults = await Promise.all([...textQueries, ...jsonbQueries]);

    // Merge results: each field has 2 queries (SC + HC), so results come in pairs
    function mergeDistinct(scRows: { value: string }[], hcRows: { value: string }[]): string[] {
      const set = new Set<string>();
      for (const r of scRows) if (r.value) set.add(r.value);
      for (const r of hcRows) if (r.value) set.add(r.value);
      return Array.from(set).sort();
    }

    const extractedOptions: Record<string, string[]> = {};
    const allFields = [...textFields, ...jsonbFields];
    for (let i = 0; i < allFields.length; i++) {
      const scRows = allResults[i * 2].rows;
      const hcRows = allResults[i * 2 + 1].rows;
      extractedOptions[allFields[i].key] = mergeDistinct(scRows, hcRows);
    }

    const options: FilterOptions = {
      courts,
      years: {
        min: yearRange[0]?.min_year || 1950,
        max: yearRange[0]?.max_year || new Date().getFullYear(),
      },
      citations: extractedOptions.citations,
      extractedPetitioners: extractedOptions.extractedPetitioners,
      extractedRespondents: extractedOptions.extractedRespondents,
      caseCategories: extractedOptions.caseCategories,
      caseNumbers: extractedOptions.caseNumbers,
      judgeNames: extractedOptions.judgeNames,
      actsCited: extractedOptions.actsCited,
      keywords: extractedOptions.keywords,
    };

    cachedOptions = options;
    cacheTime = now;

    return NextResponse.json(options);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/filters/options",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
