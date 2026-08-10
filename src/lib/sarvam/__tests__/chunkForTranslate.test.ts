import { test } from "node:test";
import assert from "node:assert";
import { chunkForTranslate } from "../client";

/**
 * Sarvam /translate takes at most ~2000 characters per call, so a document page
 * has to be cut up before it can be translated. Where those cuts land is a
 * correctness concern, not a formatting one: a boundary that falls inside a word
 * sends each half to the translator as a separate fragment, and the two halves
 * come back as unrelated nonsense with nothing to flag it. These tests pin the
 * two invariants that prevent that — no character is lost or duplicated, and no
 * boundary splits a word.
 */

const bare = (s: string) => s.replace(/\s+/g, "");
const words = (s: string) => s.split(/\s+/).filter(Boolean);

const MAX = 1800;

/** Every chunk fits the request limit. */
function assertWithinLimit(chunks: string[], max = MAX) {
  for (const c of chunks) {
    assert.ok(c.length <= max, `chunk of ${c.length} exceeds ${max}`);
    assert.ok(c.trim().length > 0, "empty chunk");
  }
}

/** Nothing was dropped or duplicated, whatever separator fell on a boundary. */
function assertLossless(chunks: string[], source: string) {
  assert.strictEqual(bare(chunks.join("")), bare(source));
}

/** No boundary fell inside a word. */
function assertWordSafe(chunks: string[], source: string) {
  assert.deepStrictEqual(words(chunks.join(" ")), words(source));
}

const CASES: Array<[name: string, text: string]> = [
  ["a short order", "The bail application is allowed subject to conditions."],
  [
    "numbered paragraphs",
    Array.from(
      { length: 12 },
      (_, i) => `${i + 1}. ` + "The applicant is accused under Section 302 IPC. ".repeat(8)
    ).join("\n\n"),
  ],
  ["one paragraph over the limit", "The applicant submits that the order is bad in law. ".repeat(120)],
  ["devanagari, danda-terminated", "यह आदेश दिनांक 12.03.2024 को पारित किया गया। ".repeat(90)],
  ["prose with no sentence terminators", "word ".repeat(2000)],
  ["heading + body + signature", "IN THE COURT OF SESSIONS\n\n" + "Order. ".repeat(400) + "\n\nSd/- Judge"],
  ["a realistic judgment page", "1. This appeal arises out of the judgment dated 14.09.1954. ".repeat(40)],
  ["page-marked text", "--- page 1 ---\n\nThe order is upheld.\n\n--- page 2 ---\n\nCosts follow."],
];

for (const [name, text] of CASES) {
  test(`chunkForTranslate: ${name}`, () => {
    const chunks = chunkForTranslate(text, MAX);
    assertWithinLimit(chunks);
    assertLossless(chunks, text);
    assertWordSafe(chunks, text);
  });
}

test("chunkForTranslate: a single token longer than the limit still can't lose text", () => {
  // Not natural language — an unbroken 5,000-character token. Word-safety is
  // impossible here by definition, but the text must still survive intact.
  const text = "x".repeat(5000);
  const chunks = chunkForTranslate(text, MAX);
  assertWithinLimit(chunks);
  assertLossless(chunks, text);
});

test("chunkForTranslate: empty and whitespace-only input yield no requests", () => {
  assert.deepStrictEqual(chunkForTranslate("", MAX), []);
  assert.deepStrictEqual(chunkForTranslate("   \n\n  \t ", MAX), []);
});

test("chunkForTranslate: packs greedily rather than one chunk per paragraph", () => {
  // 20 short paragraphs should not become 20 requests — each call is billed, and
  // more calls also means less context per call.
  const text = Array.from({ length: 20 }, (_, i) => `${i + 1}. A short numbered paragraph.`).join("\n\n");
  const chunks = chunkForTranslate(text, MAX);
  assert.strictEqual(chunks.length, 1);
});
