/**
 * End-to-end test for Design A over the REAL pipeline.
 *
 *   npx tsx scripts/e2e_support_spans.mts
 *
 * Requires DATABASE_URL, VOYAGE_API_KEY, ANTHROPIC_API_KEY in .env.local.
 *
 * Drives runAgent exactly as the SSE route does (live retrieval → agent loop →
 * grounding gate → support attachment) on real legal questions, then asserts:
 *   • the agent cited real cases,
 *   • at least one cited case carries verified `support` spans,
 *   • EVERY support quote is a verbatim substring of that case's actual excerpt
 *     (the safety invariant the citation panel relies on).
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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
for (const k of ["DATABASE_URL", "VOYAGE_API_KEY", "ANTHROPIC_API_KEY"]) {
  if (!process.env[k]) {
    console.error(`${k} not set (add to .env.local)`);
    process.exit(1);
  }
}

const { runAgent } = await import("../src/lib/rag/agent.ts");
import type { SessionDocumentStore } from "../src/lib/rag/sessionStore.ts";

const emptyStore: SessionDocumentStore = {
  caseSummaries: [],
  trace: { assistant_messages_scanned: 0, unique_cases_found: 0, cases_enriched: 0 },
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

async function run(label: string, question: string) {
  console.log(`\n──────── ${label} ────────\n"${question}"`);
  let answer = "";
  const result = await runAgent({
    userMessage: question,
    history: [],
    sessionStore: emptyStore,
    sessionFilters: {},
    onTextDelta: (d) => {
      answer += d;
    },
    onToolEvent: () => {},
    onCasesUpdate: () => {},
    onStatus: () => {},
  });

  console.log(
    `  steps=${result.stepsUsed} cases=${result.citedCases.length} ` +
      `faithfulness=${JSON.stringify(result.faithfulness)}`
  );
  check(`${label}: produced an answer`, answer.trim().length > 50);
  check(`${label}: cited at least one case`, result.citedCases.length > 0);

  const excerptByKey = new Map(
    result.assembledCases.map((c) => [`${c.source_table}:${c.source_id}`, c.excerpt])
  );

  const withSupport = result.citedCases.filter((c) => (c.support?.length ?? 0) > 0);
  console.log(`  cases carrying support spans: ${withSupport.length}/${result.citedCases.length}`);

  let totalSpans = 0;
  let verbatimSpans = 0;
  for (const c of withSupport) {
    const excerpt = norm(excerptByKey.get(`${c.source_table}:${c.id}`) ?? "");
    console.log(`\n  ▸ [${c.title}] — ${c.support!.length} span(s)`);
    for (const s of c.support!) {
      totalSpans++;
      const ok = excerpt.includes(norm(s.quote));
      if (ok) verbatimSpans++;
      console.log(`     ${ok ? "✓verbatim" : "✗NOT-IN-EXCERPT"}  claim: "${s.claim.slice(0, 70)}…"`);
      console.log(`                 quote: "${s.quote.slice(0, 90)}…"`);
    }
  }

  // The headline property: a grounded answer should surface ≥1 support span, and
  // every span shown must be verbatim. (If the judge marked everything uncertain
  // — e.g. the holding wasn't in the retrieved chunk — withSupport can be 0; we
  // flag that as a soft note, not a hard failure, since it's correct behaviour.)
  if (result.faithfulness?.ran && totalSpans === 0) {
    console.log("  ⚠ judge ran but found no verbatim-supported claims (excerpt may lack the holding)");
  }
  check(
    `${label}: every emitted support quote is verbatim`,
    totalSpans === verbatimSpans,
    `${verbatimSpans}/${totalSpans}`
  );
  return totalSpans;
}

async function main() {
  let spans = 0;
  spans += await run(
    "Bail / cooperation",
    "If an accused has cooperated with the investigation, can a court still deny bail and remand them to custody under the CrPC?"
  );
  spans += await run(
    "Pre-emption",
    "What is the right of pre-emption under Indian law, and can it be claimed for commercial property?"
  );

  console.log(`\nTotal verified support spans across runs: ${spans}`);
  check("at least one run produced verified support spans", spans > 0);
  console.log(`\n${failures === 0 ? "✅ E2E PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e harness crashed:", e);
  process.exit(1);
});
