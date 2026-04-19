#!/usr/bin/env node

/**
 * Offline retrieval eval harness.
 *
 * Runs every question in eval/golden_set.json through the same embedding +
 * hybrid-search + RRF + rerank stack the production pipeline uses, then
 * checks whether the expected cases appear in the top-K at each stage.
 *
 * Emits per-query results and aggregate metrics (recall@K, MRR, precision)
 * to stdout. The aggregate numbers are the ones to watch across changes —
 * if soft boosts or diversification regressed something, recall@12 will
 * drop.
 *
 * Usage:
 *   node scripts/eval_retrieval.mjs
 *   node scripts/eval_retrieval.mjs --verbose          (per-query breakdown)
 *   node scripts/eval_retrieval.mjs --query q_arrest_grounds (single query)
 *
 * Requires DATABASE_URL, VOYAGE_API_KEY env vars (loaded from .env.local).
 *
 * This is intentionally a standalone script rather than a call into the TS
 * pipeline — we want stable eval across pipeline refactors, and keeping the
 * retrieval math duplicated here means changes to pipeline.ts don't
 * accidentally change the eval.
 */

import pg from "pg";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── env loading ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL || !process.env.VOYAGE_API_KEY) {
  try {
    const envFile = readFileSync(resolve(ROOT, ".env.local"), "utf-8");
    for (const line of envFile.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* ignore */
  }
}
for (const k of ["DATABASE_URL", "VOYAGE_API_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} not set (add to .env.local)`);
    process.exit(1);
  }
}

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const SINGLE_QUERY_ARG = argv.find((a, i) => argv[i - 1] === "--query");

// ── constants mirroring pipeline.ts ─────────────────────────────────────
const CANDIDATE_POOL = 80;
const RRF_K = 60;
const TOP_AFTER_RERANK = 12;
const RECALL_KS = [5, 10, 20, 40, 80];
const VOYAGE_EMBED_MODEL = "voyage-law-2";
const VOYAGE_RERANK_MODEL = "rerank-2";

// ── Voyage client ───────────────────────────────────────────────────────
async function embedQueries(texts) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_EMBED_MODEL,
      input: texts,
      input_type: "query",
    }),
  });
  if (!res.ok) throw new Error(`Voyage embed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function rerank(query, documents, topK) {
  if (documents.length === 0) return [];
  const res = await fetch("https://api.voyageai.com/v1/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_RERANK_MODEL,
      query,
      documents,
      top_k: Math.min(topK, documents.length),
      truncation: true,
    }),
  });
  if (!res.ok) throw new Error(`Voyage rerank: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}

// ── DB ──────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function ftsChunks(query, limit) {
  const [sc, hc] = await Promise.all([
    pool.query(
      `SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_text,
              ts_rank(to_tsvector('english', ch.chunk_text),
                      plainto_tsquery('english', $1)) AS rank
         FROM case_chunks ch
        WHERE ch.source_table = 'supreme_court_cases'
          AND to_tsvector('english', ch.chunk_text) @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $2`,
      [query, limit]
    ),
    pool.query(
      `SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_text,
              ts_rank(to_tsvector('english', ch.chunk_text),
                      plainto_tsquery('english', $1)) AS rank
         FROM case_chunks ch
        WHERE ch.source_table = 'high_court_cases'
          AND to_tsvector('english', ch.chunk_text) @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $2`,
      [query, limit]
    ),
  ]);
  return [...sc.rows, ...hc.rows];
}

async function vectorChunks(embedding, limit) {
  const embStr = `[${embedding.join(",")}]`;
  const [sc, hc] = await Promise.all([
    pool.query(
      `SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_text,
              ch.embedding <=> $1::vector AS distance
         FROM case_chunks ch
        WHERE ch.source_table = 'supreme_court_cases'
        ORDER BY ch.embedding <=> $1::vector LIMIT $2`,
      [embStr, limit]
    ),
    pool.query(
      `SELECT ch.id AS chunk_id, ch.source_table, ch.source_id, ch.chunk_text,
              ch.embedding <=> $1::vector AS distance
         FROM case_chunks ch
        WHERE ch.source_table = 'high_court_cases'
        ORDER BY ch.embedding <=> $1::vector LIMIT $2`,
      [embStr, limit]
    ),
  ]);
  return [...sc.rows, ...hc.rows];
}

// ── retrieval: mirrors retrieveChunks() from search.ts ──────────────────
async function retrieve(queries) {
  const embeddings = await embedQueries(queries);
  const scoreMap = new Map(); // chunk_id -> { score, row }
  const addRrf = (rows) => {
    rows.forEach((row, i) => {
      const rrf = 1 / (RRF_K + i + 1);
      const existing = scoreMap.get(row.chunk_id);
      if (existing) existing.score += rrf;
      else scoreMap.set(row.chunk_id, { score: rrf, row });
    });
  };

  for (let i = 0; i < queries.length; i++) {
    const [fts, vec] = await Promise.all([
      ftsChunks(queries[i], CANDIDATE_POOL),
      vectorChunks(embeddings[i], CANDIDATE_POOL),
    ]);
    addRrf(fts);
    addRrf(vec);
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_POOL);
}

// ── metrics ─────────────────────────────────────────────────────────────
function caseKey(r) {
  return `${r.source_table}:${r.source_id}`;
}

function firstHitRank(rows, expectedKeys) {
  for (let i = 0; i < rows.length; i++) {
    if (expectedKeys.has(caseKey(rows[i]))) return i + 1;
  }
  return null;
}

function recallAtK(rows, expectedKeys, k) {
  const seen = new Set();
  for (let i = 0; i < Math.min(k, rows.length); i++) {
    seen.add(caseKey(rows[i]));
  }
  let hits = 0;
  for (const key of expectedKeys) if (seen.has(key)) hits++;
  return hits / expectedKeys.size;
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  const gold = JSON.parse(
    readFileSync(resolve(ROOT, "eval/golden_set.json"), "utf-8")
  );

  const queries = SINGLE_QUERY_ARG
    ? gold.queries.filter((q) => q.id === SINGLE_QUERY_ARG)
    : gold.queries;

  if (queries.length === 0) {
    console.error("No queries selected.");
    process.exit(1);
  }

  console.log(`\nRunning retrieval eval over ${queries.length} queries...\n`);

  const agg = {
    fused_recall: Object.fromEntries(RECALL_KS.map((k) => [k, []])),
    reranked_recall: { 12: [] },
    fused_mrr: [],
    reranked_mrr: [],
  };
  const perQuery = [];

  for (const q of queries) {
    const expectedKeys = new Set(
      q.expected_cases.map((c) => `${c.source_table}:${c.source_id}`)
    );
    if (expectedKeys.size === 0) continue;

    const t0 = Date.now();
    // For the eval, use the question as-is (no router rewrites). That tests
    // the retrieval stack independently. A separate eval can layer the router
    // in later.
    const fused = await retrieve([q.question]);

    // Rerank top N against the question.
    const rerankDocs = fused.map((r) => r.row.chunk_text);
    let reranked = [];
    if (rerankDocs.length > 0) {
      const rerankResult = await rerank(q.question, rerankDocs, TOP_AFTER_RERANK);
      reranked = rerankResult.map((r) => fused[r.index].row);
    }

    const dt = Date.now() - t0;
    const fusedRows = fused.map((f) => f.row);

    const qResult = {
      id: q.id,
      question: q.question,
      duration_ms: dt,
      expected: Array.from(expectedKeys),
      fused_first_hit: firstHitRank(fusedRows, expectedKeys),
      reranked_first_hit: firstHitRank(reranked, expectedKeys),
      fused_recall: {},
      reranked_recall_12: recallAtK(reranked, expectedKeys, 12),
      top_reranked: reranked.slice(0, 5).map(caseKey),
    };
    for (const k of RECALL_KS) {
      qResult.fused_recall[k] = recallAtK(fusedRows, expectedKeys, k);
      agg.fused_recall[k].push(qResult.fused_recall[k]);
    }
    agg.reranked_recall[12].push(qResult.reranked_recall_12);
    agg.fused_mrr.push(qResult.fused_first_hit ? 1 / qResult.fused_first_hit : 0);
    agg.reranked_mrr.push(qResult.reranked_first_hit ? 1 / qResult.reranked_first_hit : 0);
    perQuery.push(qResult);

    if (VERBOSE) {
      console.log(`[${q.id}] "${q.question.slice(0, 60)}..."`);
      console.log(`  expected: ${[...expectedKeys].join(", ")}`);
      console.log(`  fused first_hit rank: ${qResult.fused_first_hit ?? "MISS"}`);
      console.log(`  reranked first_hit rank: ${qResult.reranked_first_hit ?? "MISS"}`);
      console.log(`  reranked top-5: ${qResult.top_reranked.join(", ")}`);
      console.log(`  duration: ${dt}ms`);
      console.log();
    } else {
      const firstHit = qResult.reranked_first_hit;
      const marker = firstHit === null ? "✗" : firstHit <= 3 ? "✓" : "~";
      console.log(
        `${marker} [${q.id}] fused_r@12=${qResult.fused_recall[10].toFixed(2)} reranked_r@12=${qResult.reranked_recall_12.toFixed(2)} first_hit=${firstHit ?? "MISS"} (${dt}ms)`
      );
    }
  }

  const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  console.log("\n── Aggregate ──");
  for (const k of RECALL_KS) {
    console.log(`  fused    recall@${k}:   ${mean(agg.fused_recall[k]).toFixed(3)}`);
  }
  console.log(`  reranked recall@12:  ${mean(agg.reranked_recall[12]).toFixed(3)}`);
  console.log(`  fused    MRR:        ${mean(agg.fused_mrr).toFixed(3)}`);
  console.log(`  reranked MRR:        ${mean(agg.reranked_mrr).toFixed(3)}`);
  console.log(`\n  queries evaluated:   ${perQuery.length}`);
  console.log();

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
