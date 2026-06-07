/**
 * Tests for the leading-preamble stripper (keeps the verify→revise loop's
 * internal nudges from leaking into the user-visible answer).
 *   npx tsx --test src/lib/rag/__tests__/stripLeadingMeta.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripLeadingMeta } from "../agent.ts";

const BODY =
  "## Right of Pre-emption\n\nThe right of pre-emption is an incident of property that binds the purchaser and arises by statute or proved custom. It must be established affirmatively and cannot be presumed for commercial premises, as the authorities make clear across several decisions.";

test("strips an 'Understood, I will…' acknowledgement", () => {
  const input = "Understood. I will compose the final answer using only the retrieved passages.\n\n" + BODY;
  assert.equal(stripLeadingMeta(input), BODY);
});

test("strips an 'I now have…' reasoning preamble", () => {
  const input = "I now have all the primary source text I need.\n\n" + BODY;
  assert.equal(stripLeadingMeta(input), BODY);
});

test("leaves a normal answer untouched", () => {
  assert.equal(stripLeadingMeta(BODY), BODY);
});

test("does not strip a leading block that carries a citation (it's real content)", () => {
  const input = "The right cannot be presumed [^2].\n\n" + BODY;
  assert.equal(stripLeadingMeta(input), input);
});

test("does not strip when nothing substantive follows", () => {
  const input = "Understood.\n\nOK.";
  assert.equal(stripLeadingMeta(input), input);
});
