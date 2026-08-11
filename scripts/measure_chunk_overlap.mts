#!/usr/bin/env node

/**
 * Measure duplicated chunk text in the research agent.
 *
 * Hypothesis under test: the dominant agent flow is search_fresh → spot a
 * promising case → load_case on it. load_case renders its selected chunks in
 * full with no check against what is already in context, so every chunk that
 * search_fresh already returned for that case is sent to the model a second
 * time — and re-billed at the 1.25x prompt-cache write rate.
 *
 * If the duplicated share is large, deduping is a free win: the model already
 * has those passages, so replacing a repeat with a pointer changes nothing it
 * can reason about. If it is small, the only remaining levers on research-chat
 * cost trade away depth, and that is a product decision rather than a fix.
 *
 * Usage:
 *   npm run measure:overlap                 (whole golden set)
 *   npm run measure:overlap -- --limit 5
 *
 * Requires DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY (from .env.local).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const env = readFileSync(resolve(ROOT, ".env.local"), "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* ignore */
}
for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} not set (add to .env.local)`);
    process.exit(1);
  }
}

const { runAgent } = await import("@/lib/rag/agent");
const { setChunkEmissionSink } = await import("@/lib/rag/agentTools");
const { withMeter } = await import("@/lib/billing/meter");
const { inrToCredits, CREDIT_INR, FX_INR_PER_USD } = await import("@/lib/billing/cost");
const pool = (await import("@/lib/db")).default;
type SessionDocumentStore = import("@/lib/rag/sessionStore").SessionDocumentStore;

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = Number(arg("limit")) || 0;

const EVAL_USER_ID = Number(process.env.EVAL_USER_ID) || 325;

const emptyStore: SessionDocumentStore = {
  caseSummaries: [],
  trace: { assistant_messages_scanned: 0, unique_cases_found: 0, cases_enriched: 0 },
};

/** Sonnet cache-write rate: 1.25x input = $3.75/Mtok. What a duplicate costs. */
const CACHE_WRITE_INR_PER_1K = (3.75 / 1_000_000) * FX_INR_PER_USD * 1000;
const CHARS_PER_TOKEN = 4;

interface Row {
  id: string;
  emissions: number;
  totalChunks: number;
  uniqueChunks: number;
  dupChunks: number;
  totalChars: number;
  dupChars: number;
  credits: number;
  wastedCredits: number;
}

async function measure(q: { id: string; question: string; filters?: unknown }): Promise<Row> {
  // chunkId -> [chars on first emission, times emitted]
  const seen = new Map<number, { chars: number; count: number }>();
  let emissions = 0;
  let totalChunks = 0;
  let totalChars = 0;

  setChunkEmissionSink((emitted) => {
    emissions++;
    for (const e of emitted) {
      totalChunks++;
      totalChars += e.chars;
      const prev = seen.get(e.chunkId);
      if (prev) prev.count++;
      else seen.set(e.chunkId, { chars: e.chars, count: 1 });
    }
  });

  try {
    const { meter } = await withMeter(
      { userId: EVAL_USER_ID, feature: "chat", refId: `overlap:${q.id}` },
      () =>
        runAgent({
          userMessage: q.question,
          history: [],
          sessionStore: emptyStore,
          sessionFilters: (q.filters ?? {}) as never,
          onTextDelta: () => {},
          onToolEvent: () => {},
          onCasesUpdate: () => {},
        })
    );

    let dupChunks = 0;
    let dupChars = 0;
    for (const { chars, count } of seen.values()) {
      if (count > 1) {
        dupChunks += count - 1;
        dupChars += chars * (count - 1);
      }
    }

    // Duplicated text is re-sent into a cached prefix, so it is billed at the
    // cache-write rate. This is the money the dedup would recover.
    const wastedInr = (dupChars / CHARS_PER_TOKEN / 1000) * CACHE_WRITE_INR_PER_1K;

    return {
      id: q.id,
      emissions,
      totalChunks,
      uniqueChunks: seen.size,
      dupChunks,
      totalChars,
      dupChars,
      credits: inrToCredits(meter.costInr),
      wastedCredits: Math.round((wastedInr / CREDIT_INR) * 10) / 10,
    };
  } finally {
    setChunkEmissionSink(null);
  }
}

const gold = JSON.parse(readFileSync(resolve(ROOT, "eval/golden_set.json"), "utf-8"));
let questions = (gold.queries ?? gold.questions) as Array<{
  id: string;
  question: string;
  filters?: unknown;
}>;
if (LIMIT) questions = questions.slice(0, LIMIT);

console.log(`Measuring chunk overlap across ${questions.length} research question(s)...\n`);
const rows: Row[] = [];
for (const q of questions) {
  process.stdout.write(`  ${q.id.padEnd(34)}`);
  try {
    const r = await measure(q);
    rows.push(r);
    const pct = r.totalChars > 0 ? Math.round((r.dupChars / r.totalChars) * 100) : 0;
    process.stdout.write(
      `${String(r.credits).padStart(3)} cr  ` +
        `${String(r.totalChunks).padStart(3)} chunks (${r.dupChunks} dup, ${pct}% of chars)  ` +
        `~${r.wastedCredits} cr wasted\n`
    );
  } catch (err) {
    process.stdout.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

if (rows.length > 0) {
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const totalChars = sum((r) => r.totalChars);
  const dupChars = sum((r) => r.dupChars);
  const credits = sum((r) => r.credits);
  const wasted = sum((r) => r.wastedCredits);

  console.log("\n" + "=".repeat(72));
  console.log("CHUNK OVERLAP");
  console.log("=".repeat(72));
  console.log(`questions            ${rows.length}`);
  console.log(`chunk emissions      ${sum((r) => r.totalChunks)} (${sum((r) => r.uniqueChunks)} unique)`);
  console.log(
    `duplicated text      ${Math.round(dupChars / 1000)}k of ${Math.round(totalChars / 1000)}k chars ` +
      `(${totalChars > 0 ? Math.round((dupChars / totalChars) * 100) : 0}%)`
  );
  console.log(`credits spent        ${credits}`);
  console.log(
    `credits recoverable  ~${Math.round(wasted)} ` +
      `(${credits > 0 ? Math.round((wasted / credits) * 100) : 0}% of total)`
  );
  console.log("=".repeat(72));
  console.log(
    wasted / Math.max(1, credits) >= 0.1
      ? "→ Overlap is material. Dedup is worth building: it is quality-neutral by\n" +
        "  construction (the model already has these passages)."
      : "→ Overlap is small. Dedup will not move the number; the remaining levers on\n" +
        "  research-chat cost trade away depth."
  );
  console.log("");
}

await pool.end();
