/**
 * Tests for load_case's round-level char budget.
 *   node --experimental-strip-types --test src/lib/rag/__tests__/loadCaseBudget.test.ts
 *
 * The budget used to be per-invocation, so N parallel load_case calls admitted
 * N x the per-case cap. One such turn (7 parallel calls, ~49k tokens of
 * judgment text) cost a user 44 credits for an answer that then truncated at
 * max_tokens. These pin the two properties that keep that from recurring
 * without quietly starving a case:
 *   - a batch splits the round budget (cost is bounded)
 *   - no case ever falls below the floor (quality is bounded)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCaseCharBudget } from "../agentTools.ts";

const PER_CASE_CAP = 28_000;
const ROUND = 60_000;
const FLOOR = 6_000;

test("a lone load_case is unaffected — full per-case cap, as before", () => {
  assert.equal(loadCaseCharBudget(1), PER_CASE_CAP);
  // Defensive: callers that cannot count siblings must not get a smaller budget.
  assert.equal(loadCaseCharBudget(0), PER_CASE_CAP);
  assert.equal(loadCaseCharBudget(-3), PER_CASE_CAP);
});

test("a batch splits the round budget instead of multiplying the per-case cap", () => {
  // 3 calls: 60k/3 = 20k each, under the per-case cap so the share binds.
  assert.equal(loadCaseCharBudget(3), 20_000);
  // The turn that prompted this change: 7 parallel calls.
  assert.equal(loadCaseCharBudget(7), Math.floor(ROUND / 7));
});

test("the batch total is bounded by the round budget, not by N x per-case", () => {
  for (const n of [2, 3, 5, 7, 10]) {
    const total = loadCaseCharBudget(n) * n;
    assert.ok(
      total <= ROUND + n, // + n absorbs per-call floor() rounding
      `${n} calls admitted ${total} chars, over the ${ROUND} round budget`
    );
    // Never worse than the old per-invocation behaviour.
    assert.ok(total <= PER_CASE_CAP * n);
  }
});

test("fan-outs of 3+ are strictly cheaper than the old per-invocation budget", () => {
  // n=2 is the boundary: 60k/2 clamps back to the 28k cap, so a 2-case round is
  // exactly the old cost. The saving starts at 3, which is where real fan-outs
  // live — the turn that prompted this had 7.
  assert.equal(loadCaseCharBudget(2) * 2, PER_CASE_CAP * 2);
  for (const n of [3, 5, 7, 10]) {
    assert.ok(
      loadCaseCharBudget(n) * n < PER_CASE_CAP * n,
      `${n} parallel calls did not reduce admitted chars`
    );
  }
});

test("small batches are clamped to the per-case cap, never inflated by it", () => {
  // 60k/2 = 30k, which exceeds the per-case cap — a 2-case round must not read
  // MORE per case than a 1-case round.
  assert.equal(loadCaseCharBudget(2), PER_CASE_CAP);
});

test("no case is starved below the floor, even in a large fan-out", () => {
  // 60k/20 = 3k, below the floor. A case the user explicitly named must not be
  // reduced to a stub, so the floor deliberately wins and the round overshoots.
  assert.equal(loadCaseCharBudget(20), FLOOR);
  assert.ok(loadCaseCharBudget(20) * 20 > ROUND);
});

test("budget is monotonically non-increasing as the batch grows", () => {
  let prev = Infinity;
  for (let n = 1; n <= 25; n++) {
    const b = loadCaseCharBudget(n);
    assert.ok(b <= prev, `budget rose from ${prev} to ${b} at n=${n}`);
    assert.ok(b >= FLOOR, `budget ${b} fell below the floor at n=${n}`);
    prev = b;
  }
});
