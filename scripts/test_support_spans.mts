/**
 * Test for Design A — verified citation support spans.
 *
 *   npx tsx scripts/test_support_spans.mts
 *
 * Requires ANTHROPIC_API_KEY in .env.local (the faithfulness judge call).
 *
 * Proves, end to end:
 *   1. verifyVerbatim() (the grounding guard) accepts real substrings — even
 *      across PDF-style whitespace differences — and rejects fabricated or
 *      trivially-short quotes.
 *   2. gradeDraft() against a real judgment excerpt marks a genuine claim
 *      "supported" and returns a quote, and marks a contradicting claim
 *      "unsupported" with no quote.
 *   3. buildSupportByCase() yields support spans whose quotes are ALL verbatim
 *      substrings of the excerpt the model was shown (the core safety property).
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
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set (add to .env.local)");
  process.exit(1);
}

const { gradeDraft, buildSupportByCase, verifyVerbatim } = await import(
  "../src/lib/rag/faithfulness.ts"
);
import type { AssembledCase } from "../src/lib/rag/contextBuilder.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── Real judgment excerpt (case_chunks: supreme_court_cases #36766, chunk 16) ──
const EXCERPT = `Title: BALWANT SINGH versus UNION OF INDIA & ORS.
Citation: [2023] 4 S.C.R. 265
Court: Supreme Court of India
Date: 03-05-2023
Judges: B.R. Gavai; Vikram Nath; Sanjay Karol
Disposal: Disposed off
Result: Writ petition disposed of. No commutation ordered. Court held that there was no inordinate delay in disposal of mercy petition and that the decision to defer commutation rests within the executive domain.
Issue: Whether the Union of India has unreasonably delayed disposal of the petitioner's mercy petition filed in 2012 for commutation of death sentence, and whether the Court should direct commutation of death sentence to life imprisonment based on such delay.`;

const CASE: AssembledCase = {
  index: 1,
  source_table: "supreme_court_cases",
  source_id: 36766,
  meta: {
    title: "BALWANT SINGH versus UNION OF INDIA & ORS.",
    citation: "[2023] 4 S.C.R. 265",
  } as AssembledCase["meta"],
  extraction: { extracted_citation: "[2023] 4 S.C.R. 265" } as AssembledCase["extraction"],
  pdf_url: null,
  pdf_path: null,
  chunk_indices: [16],
  excerpt: EXCERPT,
  chunk_paragraphs: [],
};

// ── 1. The grounding guard, in isolation ──────────────────────────────────
console.log("\n── verifyVerbatim (grounding guard + sentence expansion) ──");
const realSpan = "there was no inordinate delay in disposal of mercy petition";
// The full sentence the span sits in (verifyVerbatim expands to sentence bounds).
const fullSentence =
  "Court held that there was no inordinate delay in disposal of mercy petition and that the decision to defer commutation rests within the executive domain.";
const normExc = EXCERPT.replace(/\s+/g, " ");
const v1 = verifyVerbatim(realSpan, EXCERPT);
check("accepts a real substring", Boolean(v1) && v1!.includes(realSpan), v1 ?? "(none)");
check("expands to the COMPLETE sentence (no fragment)", v1 === fullSentence, v1 ?? "(none)");
check("expanded span is itself verbatim in the excerpt", Boolean(v1) && normExc.includes(v1!));
const v2 = verifyVerbatim("there was no inordinate\n   delay in disposal of mercy petition", EXCERPT);
check("tolerates collapsed whitespace / line wraps", v2 === fullSentence, v2 ?? "(none)");
check(
  "rejects a fabricated quote",
  verifyVerbatim("the Court commuted the death sentence to life imprisonment", EXCERPT) === undefined
);
check("rejects a trivially short quote", verifyVerbatim("the Court", EXCERPT) === undefined);

// ── 2 + 3. Live judge over a real excerpt ─────────────────────────────────
const SUPPORTED_CLAIM =
  "The Supreme Court held that there was no inordinate delay in disposing of the mercy petition and that the decision to defer commutation rests within the executive domain.";
const HALLUCINATED_CLAIM =
  "The Court commuted the petitioner's death sentence to life imprisonment on account of the delay.";

const draft = `${SUPPORTED_CLAIM} [^1]\n\n${HALLUCINATED_CLAIM} [^1]`;

console.log("\n── gradeDraft (live Haiku judge over real excerpt) ──");
const grade = await gradeDraft(draft, [CASE]);
check("judge ran", grade.ran);
console.log(`   checked=${grade.checked} unsupported=${grade.unsupported.length}`);
for (const f of grade.findings) {
  console.log(`   • [${f.verdict}] "${f.claim.slice(0, 60)}…"`);
  console.log(`       reason: ${f.reason}`);
  if (f.quote) console.log(`       quote: "${f.quote}"`);
}

const supportedFinding = grade.findings.find((f) => f.claim.startsWith("The Supreme Court held"));
const hallucinatedFinding = grade.findings.find((f) => f.claim.startsWith("The Court commuted"));

check("genuine claim graded supported", supportedFinding?.verdict === "supported");
check("supported claim carries a quote", Boolean(supportedFinding?.quote), supportedFinding?.quote ?? "(none)");
check(
  "contradicting claim NOT supported",
  hallucinatedFinding?.verdict !== "supported",
  hallucinatedFinding?.verdict
);
check("contradicting claim carries NO quote", !hallucinatedFinding?.quote);

// ── buildSupportByCase + the invariant the UI relies on ───────────────────
console.log("\n── buildSupportByCase ──");
const byCase = buildSupportByCase(grade.findings);
const spans = byCase.get(1) ?? [];
check("support spans produced for case 1", spans.length > 0, `${spans.length} span(s)`);

const normExcerpt = EXCERPT.replace(/\s+/g, " ");
const allVerbatim = spans.every((s) => normExcerpt.includes(s.quote.replace(/\s+/g, " ")));
check("EVERY support quote is verbatim in the excerpt", allVerbatim);

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
