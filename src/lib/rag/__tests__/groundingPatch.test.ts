/**
 * Tests for the surgical grounding-patch helpers.
 *
 * These guard the two properties that let the patch path replace a full rewrite
 * without weakening the grounding gate: a replacement is spliced only on a
 * unique exact match, and a judge response that can't be parsed yields nothing
 * (so the caller falls back to the full rewrite rather than shipping a draft
 * with unsupported claims still in it).
 *
 *   npx tsx --test src/lib/rag/__tests__/groundingPatch.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { occurrences, parseReplacements } from "../groundingPatch.ts";

// ── occurrences ───────────────────────────────────────────────

test("counts a unique sentence once", () => {
  const draft = "The moratorium bars institution of suits.[^1] Recovery is stayed.[^2]";
  assert.equal(occurrences(draft, "The moratorium bars institution of suits.[^1]"), 1);
});

test("detects a repeated sentence as non-unique", () => {
  const claim = "The bar is absolute.[^1]";
  const draft = `Intro. ${claim} Middle text here. ${claim} Conclusion.`;
  assert.ok(occurrences(draft, claim) > 1, "repeated claim must not read as unique");
});

test("returns 0 when the claim is absent", () => {
  assert.equal(occurrences("Some answer text.", "Not present.[^9]"), 0);
});

test("returns 0 for an empty needle rather than looping", () => {
  assert.equal(occurrences("anything", ""), 0);
});

test("does not count overlapping matches twice", () => {
  // "aaa" appears at 0 and 2; non-overlapping scanning finds only the first.
  assert.equal(occurrences("aaaa", "aaa"), 1);
});

// ── parseReplacements ─────────────────────────────────────────

test("parses a clean JSON array", () => {
  const out = parseReplacements('[{"id":1,"replacement":"Narrowed statement.[^1]"}]');
  assert.equal(out.size, 1);
  assert.equal(out.get(1), "Narrowed statement.[^1]");
});

test("parses despite surrounding prose and code fences", () => {
  const raw =
    'Here are the corrections:\n```json\n[{"id":2,"replacement":"Corrected.[^3]"}]\n```\nDone.';
  const out = parseReplacements(raw);
  assert.equal(out.get(2), "Corrected.[^3]");
});

test("keeps an empty replacement, which means delete the sentence", () => {
  const out = parseReplacements('[{"id":1,"replacement":""}]');
  assert.ok(out.has(1), "an empty replacement is a deletion instruction, not a miss");
  assert.equal(out.get(1), "");
});

test("returns empty on malformed JSON so the caller falls back to a rewrite", () => {
  assert.equal(parseReplacements("I could not correct these sentences.").size, 0);
  assert.equal(parseReplacements('[{"id":1,"replacement":').size, 0);
});

test("skips entries with a non-string replacement or unusable id", () => {
  const out = parseReplacements(
    '[{"id":1,"replacement":null},{"id":"x","replacement":"a"},{"id":3,"replacement":"Kept.[^2]"}]'
  );
  assert.equal(out.size, 1);
  assert.equal(out.get(3), "Kept.[^2]");
});

test("accepts a numeric-string id, which models emit intermittently", () => {
  const out = parseReplacements('[{"id":"4","replacement":"Fixed.[^1]"}]');
  assert.equal(out.get(4), "Fixed.[^1]");
});
