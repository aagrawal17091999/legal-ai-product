/**
 * Tests for the question-decomposition parser (#2).
 *   node --experimental-strip-types --test src/lib/rag/__tests__/decompose.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecomposition } from "../decompose.ts";

const ORIG = "original question";

test("not compound → falls back to the original question", () => {
  const r = parseDecomposition('{"compound": false, "sub_questions": []}', ORIG);
  assert.equal(r.isCompound, false);
  assert.deepEqual(r.subQuestions, [ORIG]);
});

test("compound with 2+ sub-questions is accepted", () => {
  const r = parseDecomposition(
    '{"compound": true, "sub_questions": ["issue A?", "issue B?"]}',
    ORIG
  );
  assert.equal(r.isCompound, true);
  assert.deepEqual(r.subQuestions, ["issue A?", "issue B?"]);
});

test("compound but only one usable sub-question → fallback (not actionable)", () => {
  const r = parseDecomposition('{"compound": true, "sub_questions": ["only one"]}', ORIG);
  assert.equal(r.isCompound, false);
  assert.deepEqual(r.subQuestions, [ORIG]);
});

test("tolerates prose / code fences around the JSON", () => {
  const raw = 'Here you go:\n```json\n{"compound": true, "sub_questions": ["A?", "B?"]}\n```';
  const r = parseDecomposition(raw, ORIG);
  assert.equal(r.isCompound, true);
  assert.equal(r.subQuestions.length, 2);
});

test("dedupes case-insensitively", () => {
  const r = parseDecomposition(
    '{"compound": true, "sub_questions": ["Issue A?", "issue a?", "B?"]}',
    ORIG
  );
  assert.deepEqual(r.subQuestions, ["Issue A?", "B?"]);
});

test("garbage input → fallback", () => {
  assert.deepEqual(parseDecomposition("not json", ORIG).subQuestions, [ORIG]);
  assert.deepEqual(parseDecomposition("", ORIG).subQuestions, [ORIG]);
});
