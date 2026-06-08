/**
 * Live smoke test for the upgraded RAG agent (caching + the 6 practices).
 *
 *   npx tsx scripts/smoke_agent.ts
 *
 * Requires DATABASE_URL, VOYAGE_API_KEY, ANTHROPIC_API_KEY in .env.local.
 *
 * Checks, end to end:
 *   A. retrieveChunks with the #6 metadata lane runs without SQL errors.
 *   B. runAgent produces a real answer, and prompt caching actually hits
 *      (cache_read tokens > 0 on a multi-step question).
 *   C. decomposition / reflection / grounding gates fire without crashing.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Load .env.local BEFORE importing modules that read env at import time.
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

const { retrieveChunks } = await import("../src/lib/search.ts");
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

async function partA() {
  console.log("\n── A. Metadata-lane retrieval (#6) ──");
  const { chunks, trace } = await retrieveChunks(
    ["right of pre-emption commercial property"],
    {},
    40,
    { metadataLane: true }
  );
  check("retrieveChunks returned candidates", chunks.length > 0, `${chunks.length} chunks`);
  check("metadata lane executed (no SQL error)", true, `fused ${trace.fused_count}`);
}

async function runQuestion(label: string, question: string) {
  console.log(`\n── ${label} ──\n"${question}"`);
  const tools: string[] = [];
  const statuses: string[] = [];
  let answer = "";
  let cases = 0;

  const result = await runAgent({
    userMessage: question,
    history: [],
    sessionStore: emptyStore,
    sessionFilters: {},
    onTextDelta: (d) => {
      answer += d;
    },
    onToolEvent: (e) => {
      if (e.type === "start") tools.push(e.record.tool);
    },
    onCasesUpdate: (c) => {
      cases = c.length;
    },
    onStatus: (s) => statuses.push(s.phase),
  });

  const t = result.tokens;
  console.log(
    `  tools: [${tools.join(", ")}]  steps: ${result.stepsUsed}  cases: ${cases}` +
      `  statuses: [${statuses.join(", ")}]`
  );
  console.log(
    `  tokens in/out: ${t.input}/${t.output}  cacheRead: ${t.cacheRead}  cacheWrite: ${t.cacheWrite}`
  );
  console.log(`  faithfulness: ${JSON.stringify(result.faithfulness)}`);
  console.log(`  answer (${answer.length} chars): ${answer.slice(0, 220).replace(/\n/g, " ")}…`);

  check(`${label}: produced a non-empty answer`, answer.trim().length > 50);
  check(`${label}: answer === result.assistantContent`, answer === result.assistantContent);
  // No process/meta preamble or tool-internals leaked into the answer.
  const opener = answer.trimStart().slice(0, 200);
  const metaLeak =
    /^(i\b|i['’](?:ll|ve|m)|understood\b|got it\b|let me\b|here(?:'s| is)\b|based on\b|this is (?:a|an) (?:rich|comprehensive|strong|good|clear|detailed))/i.test(opener) ||
    /\b(load_case|search_fresh|lookup_by_citation|expand_cited_cases|the initial search|search results|already retrieved|i (?:now )?have (?:sufficient|comprehensive|the|all|full)|i now have|i can see|the cases surfaced|reconstruct the answer|here is (?:a )?(?:comprehensive|doctrinal))\b/i.test(opener);
  check(`${label}: no meta/tool preamble leaked`, !metaLeak, metaLeak ? `opener="${opener.slice(0, 80)}"` : "");
  if (result.stepsUsed >= 2) {
    check(`${label}: prompt cache HIT (cacheRead>0)`, t.cacheRead > 0, `${t.cacheRead} tokens`);
  } else {
    console.log("  (single step — cache read not expected)");
  }
  return result;
}

async function main() {
  await partA();
  console.log("\n── B/C. Full agent runs ──");
  await runQuestion("Simple research", "What is the right of pre-emption under Indian law?");
  await runQuestion(
    "Compound (#2 decomposition)",
    "Can a right of pre-emption be presumed for commercial property, and how does a co-sharer's right of pre-emption differ from a neighbour's right based on vicinage?"
  );

  console.log(`\n${failures === 0 ? "✅ ALL SMOKE CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke harness crashed:", e);
  process.exit(1);
});
