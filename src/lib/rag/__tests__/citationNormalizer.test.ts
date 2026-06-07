/**
 * Verification for the deterministic citation normalizer.
 *
 * Runs with Node's built-in test runner + type stripping:
 *   node --experimental-strip-types --test src/lib/rag/__tests__/citationNormalizer.test.ts
 *
 * The normalizer is load-bearing: the renderer, the citation validator, and the
 * faithfulness judge all match `\[\^…\]`, so a bare `[n]` marker the model emits
 * is invisible to all three. These tests pin the upgrade rules:
 *   - bare `[n]` → `[^n]` ONLY when n is within range (1..maxIndex),
 *   - `[n, ¶p]` (carries a ¶) → `[^n, ¶p]` ALWAYS,
 *   - already-caret markers are never touched (no `[^^n]`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCitations } from "../citationNormalizer.ts";

test("bare [n] in range is upgraded to [^n]", () => {
  const r = normalizeCitations("The right is an incident of property [1].", 7);
  assert.equal(r.text, "The right is an incident of property [^1].");
  assert.equal(r.upgraded, 1);
});

test("bare [n] out of range is left untouched", () => {
  // Only 3 cases this turn, so [8] is almost certainly not a citation.
  const r = normalizeCitations("Some statutory clause [8] in the Act.", 3);
  assert.equal(r.text, "Some statutory clause [8] in the Act.");
  assert.equal(r.upgraded, 0);
});

test("[n, ¶p] is always upgraded — the ¶ makes it unambiguous", () => {
  // Mirrors the real transcript bug: model wrote `[3, ¶15a]` (no caret).
  const r = normalizeCitations("extracted verbatim in Jagmohan [3, ¶15a].", 4);
  assert.equal(r.text, "extracted verbatim in Jagmohan [^3, ¶15a].");
  assert.equal(r.upgraded, 1);
});

test("[n, ¶p] upgrades even when n is out of range (validator then flags it)", () => {
  // We upgrade so the bad index surfaces as a validator mismatch rather than
  // being silently hidden as plain text.
  const r = normalizeCitations("Holding [9, ¶12].", 3);
  assert.equal(r.text, "Holding [^9, ¶12].");
  assert.equal(r.upgraded, 1);
});

test("no-space variant [n,¶p] is upgraded", () => {
  const r = normalizeCitations("See [1,¶28].", 2);
  assert.equal(r.text, "See [^1,¶28].");
  assert.equal(r.upgraded, 1);
});

test("compound paragraph numbers [n, ¶14.1] upgrade", () => {
  const r = normalizeCitations("See [2, ¶14.1] and [2, ¶14.2].", 3);
  assert.equal(r.text, "See [^2, ¶14.1] and [^2, ¶14.2].");
  assert.equal(r.upgraded, 2);
});

test("already-caret markers are never touched (no double caret)", () => {
  const text = "General [^1]. Pinpoint [^2, ¶12]. No-space [^3,¶5a].";
  const r = normalizeCitations(text, 5);
  assert.equal(r.text, text);
  assert.equal(r.upgraded, 0);
});

test("mixed bare + caret: only the bare ones are upgraded", () => {
  const r = normalizeCitations("First [^1]. Second [2]. Third [3, ¶7].", 3);
  assert.equal(r.text, "First [^1]. Second [^2]. Third [^3, ¶7].");
  assert.equal(r.upgraded, 2);
});

test("boundary: n === maxIndex upgrades, n === maxIndex+1 does not", () => {
  const r = normalizeCitations("In range [3]. Out of range [4].", 3);
  assert.equal(r.text, "In range [^3]. Out of range [4].");
  assert.equal(r.upgraded, 1);
});

test("maxIndex 0 (no cases): bare untouched, but ¶ form still upgrades", () => {
  const r = normalizeCitations("Bare [1] stays, pinpoint [1, ¶3] upgrades.", 0);
  assert.equal(r.text, "Bare [1] stays, pinpoint [^1, ¶3] upgrades.");
  assert.equal(r.upgraded, 1);
});

test("repeated bare markers each count", () => {
  const r = normalizeCitations("[1] then [1] then [2].", 2);
  assert.equal(r.text, "[^1] then [^1] then [^2].");
  assert.equal(r.upgraded, 3);
});

test("text with no markers is returned unchanged", () => {
  const text = "A tidy paragraph of legal analysis with no citations.";
  const r = normalizeCitations(text, 5);
  assert.equal(r.text, text);
  assert.equal(r.upgraded, 0);
});

test("the full 'Cases Referenced' list-style line upgrades cleanly", () => {
  const text =
    "[1] Audh Behari Singh (1955) — incident of property.\n" +
    "[2] Bhau Ram (1962) — vicinage struck down.";
  const r = normalizeCitations(text, 2);
  assert.equal(
    r.text,
    "[^1] Audh Behari Singh (1955) — incident of property.\n" +
      "[^2] Bhau Ram (1962) — vicinage struck down."
  );
  assert.equal(r.upgraded, 2);
});

test("documented caveat: in-range numeric markdown link [n](url) is rewritten", () => {
  // Known, accepted trade-off: a bare in-range `[1]` immediately followed by a
  // link target becomes `[^1](url)`. The product's answers don't use numeric
  // markdown links, so this is acceptable. Locked here so the behavior is
  // intentional, not accidental.
  const r = normalizeCitations("see [1](https://example.com)", 3);
  assert.equal(r.text, "see [^1](https://example.com)");
  assert.equal(r.upgraded, 1);
});
