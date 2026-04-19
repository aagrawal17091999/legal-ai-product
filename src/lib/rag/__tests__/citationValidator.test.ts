/**
 * Verification for the post-generation citation validator.
 *
 * Runs with Node's built-in test runner + type stripping:
 *   node --experimental-strip-types --test src/lib/rag/__tests__/citationValidator.test.ts
 *
 * These tests are the regression net for the original chat failure
 * ("can you tell the specific para numbers of the judgments shared")
 * — specifically, the assertion that (a) legitimate markers pass through
 * untouched, and (b) hallucinated markers produce a transparent warning
 * footer rather than silently shipping bad citations.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCitations } from "../citationValidator.ts";
import type { AssembledCase } from "../contextBuilder.ts";

function fakeCase(index: number, paragraphs: string[] = []): AssembledCase {
  return {
    index,
    source_table: "supreme_court_cases",
    source_id: 1000 + index,
    meta: {
      title: `Case ${index}`,
      citation: `CITE ${index}`,
      court: "Supreme Court of India",
      judge: null,
      decision_date: null,
      petitioner: null,
      respondent: null,
      disposal_nature: null,
      year: 2024,
      path: null,
      pdf_url: null,
    },
    extraction: {
      extracted_citation: `CITE ${index}`,
      headnotes: null,
      issue_for_consideration: null,
      acts_cited: [],
      author_judge_name: null,
      bench_size: null,
      result_of_case: null,
    },
    pdf_url: null,
    pdf_path: null,
    chunk_indices: [],
    chunk_paragraphs: paragraphs,
  };
}

test("valid markers pass through untouched", () => {
  const text =
    "Long incarceration is a sufficient ground for bail under Article 21 [^1]. " +
    "The Court held that Section 43D does not oust constitutional jurisdiction [^1, ¶28].";
  const cases = [fakeCase(1, ["28", "29", "30"])];
  const r = validateCitations(text, cases);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.text, text, "text should not be augmented when everything validates");
  assert.equal(r.allMarkers.length, 2);
});

test("unknown case index triggers warning footer", () => {
  const text = "Some holding is stated here [^99].";
  const cases = [fakeCase(1, ["1", "2"])];
  const r = validateCitations(text, cases);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].reason, "unknown_case");
  assert.equal(r.mismatches[0].case_index, 99);
  assert.match(r.text, /Citation warning/);
  assert.match(r.text, /\[\^99\]/);
});

test("unknown paragraph on a known case triggers warning", () => {
  const text = "The Court reasoned that bail is the rule [^1, ¶42].";
  const cases = [fakeCase(1, ["1", "2", "3"])]; // ¶42 not visible
  const r = validateCitations(text, cases);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].reason, "unknown_paragraph");
  assert.equal(r.mismatches[0].paragraph, "42");
  assert.match(r.text, /Citation warning/);
});

test("sub-paragraph suffix resolves to parent (42a → 42)", () => {
  const text = "The Court observed [^1, ¶42a] and then held [^1, ¶42].";
  const cases = [fakeCase(1, ["42"])]; // only the parent is visible
  const r = validateCitations(text, cases);
  // Both should pass: the literal "42a" resolves via parent-stripping to "42".
  assert.equal(r.mismatches.length, 0, `expected 0 mismatches, got ${JSON.stringify(r.mismatches)}`);
});

test("compound paragraph numbers (14.1) validate cleanly", () => {
  const text = "See [^1, ¶14.1] and [^1, ¶14.2].";
  const cases = [fakeCase(1, ["14.1", "14.2"])];
  const r = validateCitations(text, cases);
  assert.equal(r.mismatches.length, 0);
});

test("duplicate bad marker collapses to a single warning line", () => {
  const text = "Holding [^42]. Same holding [^42]. Again [^42].";
  const cases = [fakeCase(1, [])];
  const r = validateCitations(text, cases);
  assert.equal(r.mismatches.length, 3, "we track every occurrence");
  const footerLines = r.text.split("Citation warning")[1];
  const bulletCount = (footerLines.match(/^- /gm) ?? []).length;
  assert.equal(bulletCount, 1, "warning footer should collapse duplicates to one bullet");
});

test("no markers, no warnings", () => {
  const text = "This is a tidy draft with no citations at all.";
  const r = validateCitations(text, [fakeCase(1, ["1"])]);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.allMarkers.length, 0);
  assert.equal(r.text, text);
});

test("multi-case retrieval validates across all indices", () => {
  const text = "Case one says X [^1, ¶3]. Case two says Y [^2, ¶7]. Case three [^3].";
  const cases = [
    fakeCase(1, ["3", "4"]),
    fakeCase(2, ["7"]),
    fakeCase(3, []),
  ];
  const r = validateCitations(text, cases);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.allMarkers.length, 3);
});

test("marker with space variant `[^1,¶28]` still parses", () => {
  const text = "See [^1,¶28] and also [^1, ¶28].";
  const cases = [fakeCase(1, ["28"])];
  const r = validateCitations(text, cases);
  assert.equal(r.mismatches.length, 0);
  // Both variants count as separate markers for telemetry, since the raw
  // strings differ.
  assert.equal(r.allMarkers.length, 2);
});
