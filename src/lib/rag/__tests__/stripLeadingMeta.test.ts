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

// Real leaks observed in the live smoke harness:
test("strips a citation-bearing 'I now have the full verified text of Cases [^1]…' preamble", () => {
  const input =
    "I now have the full verified text of Cases [^1], [^2], and [^5]. I can see clearly from the excerpts:\n\n" + BODY;
  assert.equal(stripLeadingMeta(input), BODY);
});

test("strips a tool-internals leak ('The load_case tool is not returning…')", () => {
  const input =
    "The load_case tool is not returning the Bhau Ram case. I have sufficient text from the initial search and lookup results, and I will now reconstruct the answer.\n\n" +
    BODY;
  assert.equal(stripLeadingMeta(input), BODY);
});

test("strips multiple stacked meta paragraphs", () => {
  const input = "Understood.\n\nI now have the cases I need.\n\n" + BODY;
  assert.equal(stripLeadingMeta(input), BODY);
});

test("strips a long 'The cases surfaced in the initial search…' narration", () => {
  const input =
    "The cases surfaced in the initial search (Cases [^1], [^2], [^3]) contain the full relevant passages already retrieved from the search results. I have comprehensive excerpts from all three landmark Supreme Court cases and will set them out below in a structured form for the reader.\n\n" +
    BODY;
  assert.equal(stripLeadingMeta(input), BODY);
});

test("strips a 'This is a rich set… Here is a comprehensive overview' framing", () => {
  const input =
    "This is a rich set of Supreme Court authorities. Here is a comprehensive doctrinal overview.\n\n" + BODY;
  assert.equal(stripLeadingMeta(input), BODY);
});

test("leaves a normal answer untouched", () => {
  assert.equal(stripLeadingMeta(BODY), BODY);
});

test("keeps the '> NOTE:' grounding banner (it's a real opener)", () => {
  const input = "> NOTE: NyayaSearch has no directly relevant case on this — general guidance follows.\n\n" + BODY;
  assert.equal(stripLeadingMeta(input), input);
});

test("does not strip a substantive third-person opener that carries a citation", () => {
  const input =
    "The right of pre-emption cannot be presumed for commercial property [^2], and must be founded on statute or proved custom.\n\n" +
    BODY;
  assert.equal(stripLeadingMeta(input), input);
});

test("does not strip when nothing substantive follows", () => {
  const input = "Understood.\n\nOK.";
  assert.equal(stripLeadingMeta(input), input);
});
