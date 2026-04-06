#!/usr/bin/env node

/**
 * Diagnostic script: tests each search filter individually and finds
 * contradictory pairwise combinations that return 0 results.
 *
 * Usage: node scripts/test-filters.mjs
 * Requires DATABASE_URL env var or .env.local in project root.
 */

import pg from "pg";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load DATABASE_URL from .env.local if not set
if (!process.env.DATABASE_URL) {
  try {
    const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
    const match = envFile.match(/^DATABASE_URL=(.+)$/m);
    if (match) process.env.DATABASE_URL = match[1].trim();
  } catch {
    // ignore
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const TEXT_FILTERS = [
  { column: "extracted_citation", label: "Citation" },
  { column: "extracted_petitioner", label: "Petitioner" },
  { column: "extracted_respondent", label: "Respondent" },
  { column: "case_category", label: "Case Category" },
  { column: "case_number", label: "Case Number" },
];

const JSONB_FILTERS = [
  { column: "judge_names", label: "Judge Name" },
  { column: "acts_cited", label: "Acts Cited" },
  { column: "keywords", label: "Keyword" },
];

async function main() {
  console.log("=== Filter Diagnostic Report ===\n");

  // Table sizes
  const { rows: [counts] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM supreme_court_cases) AS sc_total,
      (SELECT COUNT(*) FROM high_court_cases) AS hc_total
  `);
  console.log(`Supreme Court cases: ${counts.sc_total}`);
  console.log(`High Court cases:    ${counts.hc_total}\n`);

  // Test each text filter
  console.log("--- Individual Text Filter Counts (SC) ---");
  const filterValues = {};
  for (const { column, label } of TEXT_FILTERS) {
    const { rows } = await pool.query(
      `SELECT ${column} AS val, COUNT(*) AS cnt
       FROM supreme_court_cases
       WHERE ${column} IS NOT NULL AND ${column} != ''
       GROUP BY ${column}
       ORDER BY cnt DESC
       LIMIT 5`
    );
    console.log(`\n${label} (${column}):`);
    if (rows.length === 0) {
      console.log("  (no values found)");
    }
    filterValues[column] = [];
    for (const r of rows) {
      console.log(`  "${r.val}" -> ${r.cnt} results`);
      filterValues[column].push({ val: r.val, cnt: parseInt(r.cnt) });
    }
  }

  // Test each JSONB filter
  console.log("\n--- Individual JSONB Filter Counts (SC) ---");
  for (const { column, label } of JSONB_FILTERS) {
    const { rows } = await pool.query(
      `SELECT val, COUNT(*) AS cnt FROM (
         SELECT DISTINCT ON (source_id, val) source_id, val
         FROM (
           SELECT id AS source_id, jsonb_array_elements_text(${column}) AS val
           FROM supreme_court_cases
           WHERE ${column} IS NOT NULL AND ${column} != '[]'::jsonb
         ) sub
       ) deduped
       GROUP BY val
       ORDER BY cnt DESC
       LIMIT 5`
    );
    console.log(`\n${label} (${column}):`);
    if (rows.length === 0) {
      console.log("  (no values found)");
    }
    filterValues[column] = [];
    for (const r of rows) {
      console.log(`  "${r.val}" -> ${r.cnt} results`);
      filterValues[column].push({ val: r.val, cnt: parseInt(r.cnt) });
    }
  }

  // Pairwise contradiction check: text x text
  console.log("\n\n--- Contradictory Filter Pairs (0 results when combined) ---\n");
  let contradictions = 0;

  const textPairs = [];
  for (let i = 0; i < TEXT_FILTERS.length; i++) {
    for (let j = i + 1; j < TEXT_FILTERS.length; j++) {
      textPairs.push([TEXT_FILTERS[i], TEXT_FILTERS[j]]);
    }
  }

  for (const [f1, f2] of textPairs) {
    const vals1 = (filterValues[f1.column] || []).slice(0, 3);
    const vals2 = (filterValues[f2.column] || []).slice(0, 3);

    for (const v1 of vals1) {
      for (const v2 of vals2) {
        const { rows: [{ cnt }] } = await pool.query(
          `SELECT COUNT(*) AS cnt FROM supreme_court_cases
           WHERE ${f1.column} = $1 AND ${f2.column} = $2`,
          [v1.val, v2.val]
        );
        if (parseInt(cnt) === 0) {
          console.log(
            `  ${f1.label}="${v1.val}" (${v1.cnt}) + ${f2.label}="${v2.val}" (${v2.cnt}) -> 0 combined`
          );
          contradictions++;
        }
      }
    }
  }

  if (contradictions === 0) {
    console.log("  No contradictory pairs found among top values.");
  } else {
    console.log(`\n  Total contradictory pairs found: ${contradictions}`);
  }

  // HC extraction coverage
  console.log("\n--- High Court Extraction Coverage ---");
  const { rows: [hcCoverage] } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(case_category) AS has_category,
      COUNT(extracted_citation) AS has_citation,
      COUNT(extracted_petitioner) AS has_petitioner
    FROM high_court_cases
  `);
  console.log(`Total HC rows: ${hcCoverage.total}`);
  console.log(`With case_category: ${hcCoverage.has_category}`);
  console.log(`With citation: ${hcCoverage.has_citation}`);
  console.log(`With petitioner: ${hcCoverage.has_petitioner}`);

  console.log("\n=== Done ===");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
