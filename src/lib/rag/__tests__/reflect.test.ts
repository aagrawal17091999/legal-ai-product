/**
 * Tests for the sufficiency-reflection parser (#1).
 *   node --experimental-strip-types --test src/lib/rag/__tests__/reflect.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReflection } from "../reflect.ts";

test("insufficient with a next_query is actionable", () => {
  const r = parseReflection('{"sufficient": false, "next_query": "pre-emption commercial property", "reason": "thin"}');
  assert.equal(r.sufficient, false);
  assert.equal(r.nextQuery, "pre-emption commercial property");
});

test("sufficient → no next query", () => {
  const r = parseReflection('{"sufficient": true, "next_query": null, "reason": "covered"}');
  assert.equal(r.sufficient, true);
  assert.equal(r.nextQuery, null);
});

test("insufficient but no usable query → treated as sufficient (nothing to do)", () => {
  const r = parseReflection('{"sufficient": false, "next_query": null}');
  assert.equal(r.sufficient, true);
  assert.equal(r.nextQuery, null);
});

test("garbage defaults to sufficient (never blocks the answer)", () => {
  assert.equal(parseReflection("nonsense").sufficient, true);
  assert.equal(parseReflection("").sufficient, true);
});
