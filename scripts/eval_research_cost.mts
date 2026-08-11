#!/usr/bin/env node

/**
 * Cost profile for the case-law research agent.
 *
 * Runs questions from eval/golden_set.json through the real runAgent() under a
 * meter and reports what each turn costs in credits, alongside the signals that
 * explain the cost (steps taken, tools called, cache hits, answer length).
 *
 * This exists because a per-question credit ceiling cannot be set from a model
 * of the pipeline — it has to be set from the distribution of real turns. Run it
 * before and after changing the budget to see both what the cap saves and where
 * it starts truncating research.
 *
 * Usage:
 *   npm run eval:research -- --tag before
 *   npm run eval:research -- --tag after --limit 6
 *   npm run eval:research -- --compare before after
 *
 * Requires DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY (from .env.local).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const { withMeter } = await import("@/lib/billing/meter");
const { inrToCredits } = await import("@/lib/billing/cost");
const pool = (await import("@/lib/db")).default;
type SessionDocumentStore = import("@/lib/rag/sessionStore").SessionDocumentStore;

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const TAG = arg("tag") ?? "run";
const LIMIT = Number(arg("limit")) || 0;
const ONLY = arg("id");
const COMPARE = argv.indexOf("--compare");
const RESULTS_DIR = resolve(ROOT, "eval/results");

const EVAL_USER_ID = Number(process.env.EVAL_USER_ID) || 325;
if (process.env.BILLING_ENFORCE === "on" && !argv.includes("--allow-billing")) {
  const { isUnlimited } = await import("@/lib/billing/credits");
  if (!(await isUnlimited(EVAL_USER_ID))) {
    console.error(
      `BILLING_ENFORCE=on and user ${EVAL_USER_ID} is not unlimited_credits — ` +
        `this would debit real turns. Set EVAL_USER_ID or pass --allow-billing.`
    );
    process.exit(1);
  }
}

const emptyStore: SessionDocumentStore = {
  caseSummaries: [],
  trace: { assistant_messages_scanned: 0, unique_cases_found: 0, cases_enriched: 0 },
};

interface Record_ {
  id: string;
  question: string;
  credits: number;
  costInr: number;
  steps: number;
  tools: string[];
  cases: number;
  answerChars: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  budgetHit: boolean;
  ms: number;
}

async function runOne(q: { id: string; question: string; filters?: unknown }): Promise<Record_> {
  const startedAt = Date.now();
  const tools: string[] = [];
  let answer = "";
  let cases = 0;

  const { result, meter } = await withMeter(
    { userId: EVAL_USER_ID, feature: "chat", refId: `researcheval:${TAG}:${q.id}` },
    () =>
      runAgent({
        userMessage: q.question,
        history: [],
        sessionStore: emptyStore,
        sessionFilters: (q.filters ?? {}) as never,
        onTextDelta: (d: string) => {
          answer += d;
        },
        onToolEvent: (e: { type: string; record: { tool: string } }) => {
          if (e.type === "start") tools.push(e.record.tool);
        },
        onCasesUpdate: (c: unknown[]) => {
          cases = c.length;
        },
      })
  );

  return {
    id: q.id,
    question: q.question,
    credits: inrToCredits(meter.costInr),
    costInr: Number(meter.costInr.toFixed(2)),
    steps: result.stepsUsed,
    tools,
    cases,
    answerChars: answer.length,
    tokens: result.tokens,
    budgetHit: Boolean((result as { budgetHit?: boolean }).budgetHit),
    ms: Date.now() - startedAt,
  };
}

function summarise(rs: Record_[]): void {
  const credits = rs.map((r) => r.credits).sort((a, b) => a - b);
  const pct = (p: number) => credits[Math.min(credits.length - 1, Math.floor(credits.length * p))];
  console.log("\n" + "=".repeat(76));
  console.log(`RESEARCH COST — tag "${TAG}"  (${rs.length} questions)`);
  console.log("=".repeat(76));
  console.log(
    "id".padEnd(34) + "cr".padStart(4) + "steps".padStart(7) + "tools".padStart(7) +
      "cases".padStart(7) + "  cache_r"
  );
  console.log("-".repeat(76));
  for (const r of rs) {
    console.log(
      r.id.padEnd(34) +
        String(r.credits).padStart(4) +
        String(r.steps).padStart(7) +
        String(r.tools.length).padStart(7) +
        String(r.cases).padStart(7) +
        `  ${r.tokens.cacheRead}` +
        (r.budgetHit ? "  [budget]" : "")
    );
  }
  console.log("-".repeat(76));
  console.log(
    `credits: min ${credits[0]}  median ${pct(0.5)}  p90 ${pct(0.9)}  max ${credits[credits.length - 1]}  ` +
      `total ${credits.reduce((a, b) => a + b, 0)}`
  );
  const over = rs.filter((r) => r.credits > 25);
  console.log(
    over.length === 0
      ? "all turns within the 25-credit ceiling"
      : `OVER 25 CREDITS: ${over.map((r) => `${r.id}(${r.credits})`).join(", ")}`
  );
  console.log("");
}

function compare(a: string, b: string): void {
  const load = (t: string): Record_[] => {
    const p = resolve(RESULTS_DIR, `research-${t}.jsonl`);
    if (!existsSync(p)) {
      console.error(`no results for tag "${t}"`);
      process.exit(1);
    }
    return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const ra = load(a);
  const rb = new Map(load(b).map((r) => [r.id, r]));
  console.log(`\n${a} → ${b}\n` + "=".repeat(76));
  console.log("id".padEnd(34) + "credits".padStart(14) + "steps".padStart(12) + "answer chars".padStart(16));
  console.log("-".repeat(76));
  let ta = 0;
  let tb = 0;
  for (const x of ra) {
    const y = rb.get(x.id);
    if (!y) continue;
    ta += x.credits;
    tb += y.credits;
    // Answer length is the cheapest proxy for "did the cap cost us substance".
    const shrink = Math.round(((x.answerChars - y.answerChars) / Math.max(1, x.answerChars)) * 100);
    console.log(
      x.id.padEnd(34) +
        `${x.credits} → ${y.credits}`.padStart(14) +
        `${x.steps} → ${y.steps}`.padStart(12) +
        `${shrink >= 0 ? "-" : "+"}${Math.abs(shrink)}%`.padStart(16) +
        (y.budgetHit ? "  [budget]" : "")
    );
  }
  console.log("-".repeat(76));
  // Print the direction explicitly. An earlier version rendered a rise as
  // "-17% lower", which reads as an improvement at exactly the moment it isn't.
  const delta = Math.round(((tb - ta) / Math.max(1, ta)) * 100);
  const dir = delta === 0 ? "no change" : delta > 0 ? `${delta}% HIGHER` : `${-delta}% lower`;
  console.log(`total credits: ${ta} → ${tb}  (${dir})`);
  console.log(
    `NOTE: single runs of a non-deterministic agent. Tool paths vary turn to turn ` +
      `(step and case counts above show it), so a delta under ~30% at this sample ` +
      `size is not evidence of anything. Use --repeat for a real comparison.`
  );
  console.log("");
}

async function main(): Promise<void> {
  if (COMPARE >= 0) {
    compare(argv[COMPARE + 1], argv[COMPARE + 2]);
    await pool.end();
    return;
  }

  const gold = JSON.parse(readFileSync(resolve(ROOT, "eval/golden_set.json"), "utf-8"));
  // golden_set.json keys its list `queries` (docchat_set.json uses `questions`).
  let questions = (gold.queries ?? gold.questions) as Array<{
    id: string;
    question: string;
    filters?: unknown;
  }>;
  if (ONLY) questions = questions.filter((q) => q.id === ONLY);
  if (LIMIT) questions = questions.slice(0, LIMIT);

  console.log(`Running ${questions.length} research question(s) as tag "${TAG}"...\n`);
  const records: Record_[] = [];
  for (const q of questions) {
    process.stdout.write(`  ${q.id.padEnd(34)}`);
    try {
      const r = await runOne(q);
      records.push(r);
      process.stdout.write(
        `${String(r.credits).padStart(3)} cr  ${r.steps} steps  ${(r.ms / 1000).toFixed(0)}s` +
          (r.budgetHit ? "  [budget]" : "") + "\n"
      );
    } catch (err) {
      process.stdout.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    resolve(RESULTS_DIR, `research-${TAG}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n"
  );
  summarise(records);
}

await main();
