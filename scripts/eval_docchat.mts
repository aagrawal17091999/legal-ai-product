#!/usr/bin/env node

/**
 * Workspace doc-chat eval harness.
 *
 * Runs every question in eval/docchat_set.json through the real runDocChat()
 * path, grades each answer with an LLM judge against the gold notes, and
 * records what the turn cost in credits. Results are written to
 * eval/results/docchat-<tag>.jsonl so two runs can be diffed.
 *
 * The point of this harness is the PER-CATEGORY breakdown. Moving workspace
 * chat from whole-corpus stuffing to agentic retrieval is expected to improve
 * `lookup` and cut cost across the board while putting `exhaustive` and
 * `absence` at risk — those two categories are the ones that decide whether the
 * change ships. An overall average would hide exactly the regression we care
 * about, so the summary never prints one.
 *
 * Unlike eval_retrieval.mjs (which deliberately duplicates the retrieval math
 * so the eval is stable across pipeline refactors), this harness calls the
 * production code path on purpose: the thing under test IS the answering
 * architecture, so it has to run whatever answer.ts currently does.
 *
 * Usage:
 *   npm run eval:docchat -- --tag baseline
 *   npm run eval:docchat -- --tag agent --category exhaustive
 *   npm run eval:docchat -- --id vj_all_authorities --verbose
 *   npm run eval:docchat -- --compare baseline agent
 *
 * Requires DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY (from .env.local).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── env loading (same pattern as eval_retrieval.mjs) ─────────────────────
if (!process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY) {
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
for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} not set (add to .env.local)`);
    process.exit(1);
  }
}

// Imported after env loading — these modules read env at module scope.
const { runDocChat } = await import("@/lib/docchat/answer");
const { withMeter } = await import("@/lib/billing/meter");
const { inrToCredits } = await import("@/lib/billing/cost");
const pool = (await import("@/lib/db")).default;

// ── args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const VERBOSE = argv.includes("--verbose");
const TAG = arg("tag") ?? "run";
const ONLY_CATEGORY = arg("category");
const ONLY_ID = arg("id");
const COMPARE = argv.indexOf("--compare");

/**
 * Metering needs a user to attribute each turn to. A full eval run is dozens of
 * billable turns, so under BILLING_ENFORCE=on it would drain a real wallet —
 * refuse unless the eval user carries `unlimited_credits` (migration 025), which
 * makes finalizeMeter record usage for analytics without debiting.
 */
const EVAL_USER_ID = Number(process.env.EVAL_USER_ID) || 325;
if (process.env.BILLING_ENFORCE === "on" && !argv.includes("--allow-billing")) {
  const { isUnlimited } = await import("@/lib/billing/credits");
  if (!(await isUnlimited(EVAL_USER_ID))) {
    console.error(
      `BILLING_ENFORCE=on and user ${EVAL_USER_ID} is not flagged unlimited_credits — ` +
        `this run would debit ${questionCountHint()} real turns. Set EVAL_USER_ID to an ` +
        `unlimited account, or re-run with --allow-billing if that is intended.`
    );
    process.exit(1);
  }
}

/** Rough turn count for the guard message (filters are applied later). */
function questionCountHint(): string {
  return ONLY_ID ? "1" : "several";
}

const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL?.trim() || "claude-sonnet-4-6";
const RESULTS_DIR = resolve(ROOT, "eval/results");

interface GoldQuestion {
  id: string;
  workspace: string;
  category: string;
  question: string;
  expected: string;
  must_include?: string[];
  must_not_include?: string[];
  expect_citations?: boolean;
  verified?: boolean;
}

interface Verdict {
  pass: boolean;
  score: number;
  missing: string[];
  hallucinated: string[];
  reason: string;
}

interface RunRecord extends Verdict {
  id: string;
  category: string;
  workspace: string;
  question: string;
  answer: string;
  mode: string;
  model: string;
  credits: number;
  costInr: number;
  citationCount: number;
  danglingRefs: number[];
  hardFailures: string[];
  ms: number;
  verified: boolean;
}

// ── deterministic checks (run before the judge) ──────────────────────────

/** Citation markers the answer actually used, e.g. "[1] ... [2][3]". */
function citedRefs(answer: string): number[] {
  const refs = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) refs.add(Number(m[1]));
  return [...refs].sort((a, b) => a - b);
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Rewrite every date-shaped string to canonical dd.mm.yyyy.
 *
 * `must_include` exists to assert facts, not spellings. An answer that says
 * "4 May 2026" has the same fact as one that says "04.05.2026", and failing it
 * for the formatting would make the harness reward models that happen to echo
 * the document's punctuation. Both sides are canonicalised before comparison.
 */
function canonicaliseDates(text: string): string {
  return (
    text
      // "4 May 2026", "4th May, 2026"
      .replace(
        /\b(\d{1,2})(?:st|nd|rd|th)?[\s,]+([A-Za-z]{3,9})[\s,]+(\d{4})\b/g,
        (m, d: string, mon: string, y: string) => {
          const mm = MONTHS[mon.slice(0, 3).toLowerCase()];
          return mm ? `${d.padStart(2, "0")}.${mm}.${y}` : m;
        }
      )
      // "May 4, 2026"
      .replace(
        /\b([A-Za-z]{3,9})[\s,]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})\b/g,
        (m, mon: string, d: string, y: string) => {
          const mm = MONTHS[mon.slice(0, 3).toLowerCase()];
          return mm ? `${d.padStart(2, "0")}.${mm}.${y}` : m;
        }
      )
      // "04/05/2026", "04-05-2026"
      .replace(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g, (_m, d: string, mo: string, y: string) =>
        `${d.padStart(2, "0")}.${mo.padStart(2, "0")}.${y}`
      )
      // "4.5.2026" → "04.05.2026"
      .replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (_m, d: string, mo: string, y: string) =>
        `${d.padStart(2, "0")}.${mo.padStart(2, "0")}.${y}`
      )
  );
}

/**
 * Literal string checks plus citation integrity. These are cheap, objective,
 * and not subject to judge drift — a `must_include` miss is a hard fail no
 * matter how well the answer reads.
 */
function hardChecks(
  q: GoldQuestion,
  answer: string,
  citationRefs: number[]
): { failures: string[]; dangling: number[] } {
  const failures: string[] = [];
  const hay = answer.toLowerCase();
  const hayDates = canonicaliseDates(answer).toLowerCase();

  for (const s of q.must_include ?? []) {
    const needle = s.toLowerCase();
    const found =
      hay.includes(needle) || hayDates.includes(canonicaliseDates(s).toLowerCase());
    if (!found) failures.push(`missing required string: "${s}"`);
  }
  for (const s of q.must_not_include ?? []) {
    if (hay.includes(s.toLowerCase())) failures.push(`contains forbidden string: "${s}"`);
  }

  // Every [n] in the prose must resolve to a citation the answer actually
  // returned. A dangling ref is the failure mode the ChunkRegistry port exists
  // to prevent, so it is checked on every run, not just citation questions.
  const used = citedRefs(answer);
  const dangling = used.filter((r) => !citationRefs.includes(r));
  if (dangling.length > 0) failures.push(`dangling citation refs: ${dangling.join(", ")}`);

  if (q.expect_citations && used.length === 0) failures.push("no citation markers in answer");

  return { failures, dangling };
}

// ── LLM judge ────────────────────────────────────────────────────────────

const JUDGE_PROMPT = `You are grading an answer produced by a legal document assistant against a gold standard.

The assistant may ONLY use the uploaded documents. Grade strictly on substance, not style or length.

Return ONLY a JSON object with this shape:
{"pass": boolean, "score": number between 0 and 1, "missing": [strings], "hallucinated": [strings], "reason": "one sentence"}

Rules:
- "missing" lists facts the gold standard requires that the answer omits.
- "hallucinated" lists factual claims in the answer that the gold standard CONTRADICTS. A claim the gold standard merely does not mention is NOT a hallucination unless the gold standard says its list is complete — real documents contain more than any gold answer enumerates, and penalising extra detail would reward answers that under-report.
- For exhaustive questions ("list every X"), omitting even one required item means pass=false. Completeness is the whole point.
- For absence questions, a clear statement that the document does not cover the topic is a PASS. Hedging that implies the topic might be covered, or inventing content, is a FAIL.
- For negative controls, answering from general knowledge instead of declining is a FAIL even if the general knowledge is correct.
- Do not reward confident tone. An answer that is fluent but incomplete fails.`;

const judgeClient = new Anthropic();

async function judge(q: GoldQuestion, answer: string): Promise<Verdict> {
  if (!answer.trim()) {
    return { pass: false, score: 0, missing: ["empty answer"], hallucinated: [], reason: "empty answer" };
  }
  const res = await judgeClient.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    system: JUDGE_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `CATEGORY: ${q.category}\n\nQUESTION:\n${q.question}\n\n` +
          `GOLD STANDARD (what a correct answer must contain):\n${q.expected}\n\n` +
          (q.verified
            ? ""
            : `NOTE: this gold standard is UNVERIFIED and known to be partial — it was drafted ` +
              `from a partial read of the source. Grade only on whether the required facts are ` +
              `present; do NOT report additional facts as hallucinations.\n\n`) +
          `ANSWER TO GRADE:\n${answer}`,
      },
    ],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return {
      pass: parsed.pass === true,
      score: typeof parsed.score === "number" ? parsed.score : parsed.pass ? 1 : 0,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      hallucinated: Array.isArray(parsed.hallucinated) ? parsed.hallucinated : [],
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    return { pass: false, score: 0, missing: [], hallucinated: [], reason: "judge returned unparseable output" };
  }
}

// ── run one question ─────────────────────────────────────────────────────

async function runOne(q: GoldQuestion): Promise<RunRecord> {
  const startedAt = Date.now();
  let answer = "";

  const { result, meter } = await withMeter(
    { userId: EVAL_USER_ID, feature: "workspace_chat", refId: `eval:${TAG}:${q.id}` },
    () =>
      runDocChat({
        workspaceId: q.workspace,
        userMessage: q.question,
        history: [],
        onTextDelta: (d) => {
          answer += d;
        },
      })
  );

  const ms = Date.now() - startedAt;
  if (!answer) answer = result.assistantContent;

  const refs = result.citations.map((c) => c.ref);
  const { failures, dangling } = hardChecks(q, answer, refs);
  const verdict = await judge(q, answer);

  // A hard-check failure overrides a generous judge: the literal facts are not
  // a matter of opinion.
  const pass = verdict.pass && failures.length === 0;

  return {
    id: q.id,
    category: q.category,
    workspace: q.workspace,
    question: q.question,
    answer,
    mode: result.mode,
    model: result.model,
    // Shadow mode reports credits: 0 (nothing is debited), so derive the number
    // from measured rupee cost instead of reading meter.credits.
    credits: inrToCredits(meter.costInr),
    costInr: Number(meter.costInr.toFixed(2)),
    citationCount: result.citations.length,
    danglingRefs: dangling,
    hardFailures: failures,
    ms,
    verified: q.verified === true,
    ...verdict,
    pass,
  };
}

// ── reporting ────────────────────────────────────────────────────────────

function summarise(records: RunRecord[]): void {
  const byCategory = new Map<string, RunRecord[]>();
  for (const r of records) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  console.log("\n" + "=".repeat(78));
  console.log(`RESULTS — tag "${TAG}"   (${records.length} questions)`);
  console.log("=".repeat(78));
  console.log(
    "category".padEnd(18) +
      "pass".padEnd(10) +
      "avg score".padEnd(12) +
      "med credits".padEnd(14) +
      "modes"
  );
  console.log("-".repeat(78));

  for (const [cat, rs] of [...byCategory.entries()].sort()) {
    const passed = rs.filter((r) => r.pass).length;
    const avg = rs.reduce((a, r) => a + r.score, 0) / rs.length;
    const credits = rs.map((r) => r.credits).sort((a, b) => a - b);
    const med = credits[Math.floor(credits.length / 2)];
    const modes = [...new Set(rs.map((r) => r.mode))].join(",");
    console.log(
      cat.padEnd(18) +
        `${passed}/${rs.length}`.padEnd(10) +
        avg.toFixed(2).padEnd(12) +
        String(med).padEnd(14) +
        modes
    );
  }

  const totalCredits = records.reduce((a, r) => a + r.credits, 0);
  const sorted = records.map((r) => r.credits).sort((a, b) => a - b);
  console.log("-".repeat(78));
  console.log(
    `credits: total ${totalCredits}  median ${sorted[Math.floor(sorted.length / 2)]}  ` +
      `p90 ${sorted[Math.floor(sorted.length * 0.9)]}  max ${sorted[sorted.length - 1]}`
  );

  const unverified = records.filter((r) => !r.verified);
  if (unverified.length > 0) {
    console.log(
      `\nNOTE: ${unverified.length} question(s) have unverified gold answers ` +
        `(${unverified.map((r) => r.id).join(", ")}) — their scores are indicative only.`
    );
  }

  const failures = records.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) {
      console.log(`  [${f.category}] ${f.id}: ${f.reason}`);
      if (f.hardFailures.length > 0) console.log(`      hard: ${f.hardFailures.join("; ")}`);
      if (f.missing.length > 0) console.log(`      missing: ${f.missing.join("; ")}`);
      if (f.hallucinated.length > 0) console.log(`      hallucinated: ${f.hallucinated.join("; ")}`);
    }
  }
  console.log("");
}

/** Diff two saved runs per category — the ship / don't-ship view. */
function compare(tagA: string, tagB: string): void {
  const load = (tag: string): RunRecord[] => {
    const path = resolve(RESULTS_DIR, `docchat-${tag}.jsonl`);
    if (!existsSync(path)) {
      console.error(`no results for tag "${tag}" at ${path}`);
      process.exit(1);
    }
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunRecord);
  };

  const a = load(tagA);
  const b = load(tagB);
  const bById = new Map(b.map((r) => [r.id, r]));
  const cats = [...new Set([...a, ...b].map((r) => r.category))].sort();

  console.log(`\n${tagA} → ${tagB}\n` + "=".repeat(78));
  console.log(
    "category".padEnd(18) + "pass".padEnd(16) + "score".padEnd(18) + "median credits"
  );
  console.log("-".repeat(78));

  for (const cat of cats) {
    const ca = a.filter((r) => r.category === cat);
    const cb = b.filter((r) => r.category === cat);
    if (ca.length === 0 || cb.length === 0) continue;
    const pa = ca.filter((r) => r.pass).length;
    const pb = cb.filter((r) => r.pass).length;
    const sa = ca.reduce((x, r) => x + r.score, 0) / ca.length;
    const sb = cb.reduce((x, r) => x + r.score, 0) / cb.length;
    const med = (rs: RunRecord[]) =>
      rs.map((r) => r.credits).sort((x, y) => x - y)[Math.floor(rs.length / 2)];
    const flag = pb < pa ? "  ← REGRESSION" : "";
    console.log(
      cat.padEnd(18) +
        `${pa}/${ca.length} → ${pb}/${cb.length}`.padEnd(16) +
        `${sa.toFixed(2)} → ${sb.toFixed(2)}`.padEnd(18) +
        `${med(ca)} → ${med(cb)}${flag}`
    );
  }

  console.log("-".repeat(78));
  const totA = a.reduce((x, r) => x + r.credits, 0);
  const totB = b.reduce((x, r) => x + r.credits, 0);
  const pct = totA > 0 ? Math.round(((totA - totB) / totA) * 100) : 0;
  console.log(`total credits: ${totA} → ${totB}  (${pct >= 0 ? "-" : "+"}${Math.abs(pct)}%)`);

  // Per-question flips, so a category that nets out flat but churns underneath
  // is still visible.
  const flips = a
    .filter((r) => bById.has(r.id) && r.pass !== bById.get(r.id)!.pass)
    .map((r) => `${r.pass ? "PASS→FAIL" : "FAIL→PASS"}  [${r.category}] ${r.id}`);
  if (flips.length > 0) console.log("\n" + flips.join("\n"));
  console.log("");
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (COMPARE >= 0) {
    compare(argv[COMPARE + 1], argv[COMPARE + 2]);
    await pool.end();
    return;
  }

  const gold = JSON.parse(readFileSync(resolve(ROOT, "eval/docchat_set.json"), "utf-8"));
  let questions: GoldQuestion[] = gold.questions;
  if (ONLY_CATEGORY) questions = questions.filter((q) => q.category === ONLY_CATEGORY);
  if (ONLY_ID) questions = questions.filter((q) => q.id === ONLY_ID);

  if (questions.length === 0) {
    console.error("no questions matched the filters");
    process.exit(1);
  }

  console.log(`Running ${questions.length} question(s) as tag "${TAG}"...\n`);

  const records: RunRecord[] = [];
  // Serial on purpose: concurrent turns would contend on the same Anthropic
  // rate limit and make the per-question latency numbers meaningless.
  for (const q of questions) {
    process.stdout.write(`  ${q.id.padEnd(24)}`);
    try {
      const rec = await runOne(q);
      records.push(rec);
      process.stdout.write(
        `${rec.pass ? "PASS" : "FAIL"}  ${String(rec.credits).padStart(3)} cr  ` +
          `${rec.mode.padEnd(10)} ${(rec.ms / 1000).toFixed(1)}s\n`
      );
      if (VERBOSE) console.log(`      ${rec.reason}\n      ${rec.answer.slice(0, 300)}...\n`);
    } catch (err) {
      process.stdout.write(`ERROR  ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = resolve(RESULTS_DIR, `docchat-${TAG}.jsonl`);
  writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  summarise(records);
  console.log(`written: ${out}`);
  await pool.end();
}

await main();
