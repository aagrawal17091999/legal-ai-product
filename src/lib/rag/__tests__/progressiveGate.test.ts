import { test } from "node:test";
import assert from "node:assert";
import { ProgressiveGate } from "../progressiveGate.ts";

/**
 * These exercise the release machinery — ordering, the one-behind hold, and
 * cancellation — using uncited paragraphs, which take the gate's "nothing to
 * verify" path and so never touch the judge or the network. The grounding
 * behaviour itself is covered by the faithfulness/groundingPatch tests.
 */

function makeGate(extra: Record<string, unknown> = {}) {
  const released: string[] = [];
  const gate = new ProgressiveGate({
    cases: [],
    onRelease: (c) => released.push(c),
    ...extra,
  } as ConstructorParameters<typeof ProgressiveGate>[0]);
  return { gate, released };
}

test("holds the newest paragraph back until the stream ends", async () => {
  const { gate, released } = makeGate();
  gate.push("First paragraph.\n\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(released, [], "a lone paragraph must not be released yet");

  gate.push("Second paragraph.\n\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    released,
    ["First paragraph.\n\n"],
    "the first releases only once the second has started"
  );

  const out = await gate.finish();
  assert.equal(out.text, "First paragraph.\n\nSecond paragraph.\n\n");
  assert.equal(out.releasedChars, out.text.length);
});

test("releases in document order and reproduces the answer exactly", async () => {
  const { gate, released } = makeGate();
  for (const p of ["Alpha.", "Bravo.", "Charlie.", "Delta."]) {
    gate.push(`${p}\n\n`);
  }
  const out = await gate.finish();
  assert.equal(released.join(""), out.text, "released text must equal final text");
  assert.deepEqual(released, [
    "Alpha.\n\n",
    "Bravo.\n\n",
    "Charlie.\n\n",
    "Delta.\n\n",
  ]);
});

test("a tool call cancels release, so narration never reaches the user", async () => {
  const { gate, released } = makeGate();
  gate.push("Let me look at the limitation cases.\n\n");
  gate.cancelRelease(); // what the stream's tool_use block triggers
  gate.push("More narration.\n\n");
  const out = await gate.finish();
  assert.deepEqual(released, [], "nothing may be released after cancellation");
  assert.equal(out.releasedChars, 0);
  assert.equal(gate.hasReleased, false);
});

test("a paragraph split across many deltas is buffered until complete", async () => {
  const { gate, released } = makeGate();
  for (const d of ["The ", "moratorium ", "bars ", "suits.", "\n", "\n"]) {
    gate.push(d);
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(released, [], "still the newest paragraph — held back");
  gate.push("Next.\n\n");
  const out = await gate.finish();
  assert.equal(out.text, "The moratorium bars suits.\n\nNext.\n\n");
});

test("transform can drop a preamble before it is ever released", async () => {
  let sawSubstance = false;
  const { gate, released } = makeGate({
    transform: (part: string) => {
      if (!sawSubstance) {
        if (/^(understood|i['’]ll)\b/i.test(part.trim())) return null;
        sawSubstance = true;
      }
      return part;
    },
  });
  gate.push("Understood, I will revise.\n\n");
  gate.push("Section 14 excludes the period.\n\n");
  gate.push("Costs follow the event.\n\n");
  const out = await gate.finish();
  assert.ok(!out.text.includes("Understood"), "preamble must not survive");
  assert.equal(released.join(""), out.text);
});

test("trailing text with no blank line is still verified and released", async () => {
  const { gate, released } = makeGate();
  gate.push("Body.\n\nTail with no trailing newline.");
  const out = await gate.finish();
  assert.equal(out.text, "Body.\n\nTail with no trailing newline.");
  assert.equal(released.join(""), out.text);
});
