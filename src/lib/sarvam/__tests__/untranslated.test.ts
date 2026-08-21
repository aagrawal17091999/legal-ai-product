import { test } from "node:test";
import assert from "node:assert";
import { isUntranslated, stripPreamble } from "../client";

/**
 * `sarvam-translate:v1` is an instruction-tuned LLM, so a 200 response is not
 * evidence that a translation happened: it can echo the input back or answer in
 * chat register. Both shipped into a real user's document. These tests pin the
 * two detectors that now stand between that and the output.
 */

const HI = "hi-IN";
const EN = "en-IN";

// A real span from the bylaws document that came back untranslated in production.
const HINDI =
  "कोई भी सदस्य जो अपने भूखंड या उस पर बने भवन को बेचना चाहता हो, तो वह पहले समिति को " +
  "उसे खरीदने का अवसर देगा और समिति उसे ऐसे मूल्य पर खरीदेगी जो प्रबन्ध कमेटी द्वारा तय हुआ हो।";
const ENGLISH =
  "Any member who wishes to sell their plot or the building constructed on it shall " +
  "first give the committee an opportunity to purchase it, and the committee shall " +
  "purchase it at such price as is fixed by the management committee.";

test("a verbatim echo is caught", () => {
  assert.ok(isUntranslated(HINDI, HINDI, HI, EN));
});

test("an echo with only whitespace changes is caught", () => {
  assert.ok(isUntranslated(HINDI, `\n\n  ${HINDI.replace(/ /g, "  ")}  `, HI, EN));
});

test("a real translation passes", () => {
  assert.ok(!isUntranslated(HINDI, ENGLISH, HI, EN));
});

test("a half-translated chunk is caught", () => {
  // The failure that actually shipped: one clause rendered, the rest passed through.
  const half = `${ENGLISH.slice(0, 60)} ${HINDI.slice(40)}`;
  assert.ok(isUntranslated(HINDI, half, HI, EN));
});

test("transliterated proper nouns do not trigger a false positive", () => {
  const withResidue = `${ENGLISH} (मसूरी Dehradun Development Authority)`;
  assert.ok(!isUntranslated(HINDI, withResidue, HI, EN));
});

test("an empty result is untranslated", () => {
  assert.ok(isUntranslated(HINDI, "   ", HI, EN));
});

test("a chunk with little source script is not judged on script", () => {
  // Parenthetical-English-heavy bylaw text: too little Devanagari to measure.
  const mostlyEnglish = "Swimming Pool (तरन ताल)";
  assert.ok(!isUntranslated(mostlyEnglish, "Swimming Pool (taran taal)", HI, EN));
});

test("same-script pairs fall back to the echo test only", () => {
  // Hindi→Marathi share Devanagari, so the ratio test must not fire.
  assert.ok(!isUntranslated(HINDI, `${HINDI} अधिक`, HI, "mr-IN"));
  assert.ok(isUntranslated(HINDI, HINDI, HI, "mr-IN"));
});

test("an unknown language code skips the script test", () => {
  assert.ok(!isUntranslated(HINDI, HINDI + " x", HI, "zz-ZZ"));
});

const PREAMBLES = [
  "Here is the translation of the Hindi text to English:",
  "Here's the translation:",
  "Sure, here is the English translation of the given text:",
  "Below is the translation of the above passage into English:",
];

for (const p of PREAMBLES) {
  test(`preamble stripped: ${p.slice(0, 32)}…`, () => {
    assert.strictEqual(stripPreamble(`${p}\n${ENGLISH}`).trim(), ENGLISH);
  });
}

test("a preamble with no content after it is left alone", () => {
  // Better to keep something a reviewer can see than to silently empty a chunk.
  const only = "Here is the translation:";
  assert.strictEqual(stripPreamble(only), only);
});

test("legitimate document text beginning similarly is not stripped", () => {
  const body = "Here is the order of the court, translated and certified by the registrar.";
  assert.strictEqual(stripPreamble(body), body);
});

test("a preamble mid-text is not stripped (only a leading one)", () => {
  const body = `${ENGLISH} Here is the translation of the Hindi text to English: more.`;
  assert.strictEqual(stripPreamble(body), body);
});

/**
 * The detection guard. Sarvam /text-lid reported `en-IN` for a page that was
 * 96.6% Devanagari; because the target was also English, the "already in the
 * target language" branch skipped translation and the user received their own
 * Hindi back as the finished document. These pin the guard that now stops it.
 */
import { scriptMatchesLanguage, dominantScript } from "../languages";

const REAL_PAGE =
  "से अधिक नहीं होगी। भवन का भूमिगत २८ फीट ऊँचाई में नहीं गिनी जायेगी । " +
  "जर का तरन ताल (Swimming Pool) वा हेण्ड पम्प आदि नही बनेगा। बरसात के अनुमति होगी । " +
  "४१. संक्रमण (Transition) तथा उत्तराधिकार १) कोई सदस्य प्रबन्ध समिति की पूर्व स्वीकृति से " +
  "अपने भूखण्ड या उस पर बने भवन को दूसरे सदस्य के भूखण्ड अथवा उस पर बने भवन से।";

test("the page that broke production is not accepted as English", () => {
  assert.strictEqual(scriptMatchesLanguage(REAL_PAGE, "en-IN"), false);
});

test("the same page is accepted as Hindi", () => {
  assert.ok(scriptMatchesLanguage(REAL_PAGE, "hi-IN"));
});

test("script cannot distinguish languages that share one", () => {
  // Marathi and Hindi are both Devanagari — the guard must not reject either.
  assert.ok(scriptMatchesLanguage(REAL_PAGE, "mr-IN"));
});

test("genuine English is accepted as English", () => {
  const english =
    "No member shall allow any person other than an immediate relative to reside " +
    "in the building without the prior approval of the management committee.";
  assert.ok(scriptMatchesLanguage(english, "en-IN"));
  assert.strictEqual(scriptMatchesLanguage(english, "hi-IN"), false);
});

test("a genuinely mixed page is given the benefit of the doubt", () => {
  const mixed = "Transition तथा उत्तराधिकार Swimming Pool तरन ताल vacant land जमीन WILL वसीयतनामा";
  assert.strictEqual(dominantScript(mixed), null);
  assert.ok(scriptMatchesLanguage(mixed, "en-IN"));
  assert.ok(scriptMatchesLanguage(mixed, "hi-IN"));
});

test("too little text to judge is never rejected", () => {
  assert.strictEqual(dominantScript("भवन"), null);
  assert.ok(scriptMatchesLanguage("भवन", "en-IN"));
});

test("an unknown language code is never rejected", () => {
  assert.ok(scriptMatchesLanguage(REAL_PAGE, "zz-ZZ"));
});

/**
 * The output-side guard. Haiku runs speculatively on both text modes because it
 * is ~5x cheaper, but it does not reliably translate — on the real bylaws page it
 * returned every Devanagari character untranslated while structuring the page
 * correctly, 3 runs out of 3. This is what catches that and escalates.
 */
import { batchLooksUntranslated } from "../../translate/translate.ts";

const block = (...texts: string[]) => ({
  blocks: [{ type: "paragraph", number: null, runs: texts.map((t) => ({ text: t })) }],
});

test("a structured-but-untranslated batch is caught", () => {
  assert.ok(batchLooksUntranslated(block(REAL_PAGE), "English"));
});

test("a genuine English translation passes", () => {
  const english =
    "No member shall permit any person other than a close relative to reside in his " +
    "building without the prior approval of the Managing Committee, and any such " +
    "person shall be deemed to be a tenant for the purposes of these bye-laws.";
  assert.strictEqual(batchLooksUntranslated(block(english), "English"), false);
});

test("transliterated proper nouns do not trigger escalation", () => {
  const withResidue =
    "The Mussoorie Dehradun Development Authority (मसूरी देहरादून) shall not be " +
    "involved in the approval of any building plan submitted under this bye-law.";
  assert.strictEqual(batchLooksUntranslated(block(withResidue), "English"), false);
});

test("a Hindi target is not judged against the Latin script", () => {
  // Translating INTO Hindi must not read as untranslated.
  assert.strictEqual(batchLooksUntranslated(block(REAL_PAGE), "Hindi"), false);
});

test("text nested in kv/table blocks is inspected too", () => {
  const nested = {
    blocks: [
      { type: "kv", rows: [{ key: "समिति", value: [{ text: REAL_PAGE }] }] },
      { type: "table", header: ["a"], rows: [[[{ text: REAL_PAGE }]]] },
    ],
  };
  assert.ok(batchLooksUntranslated(nested, "English"));
});

test("a null batch and an unknown target never escalate", () => {
  assert.strictEqual(batchLooksUntranslated(null, "English"), false);
  assert.strictEqual(batchLooksUntranslated(block(REAL_PAGE), "Klingon"), false);
});

test("too little text to judge does not escalate", () => {
  assert.strictEqual(batchLooksUntranslated(block("भवन"), "English"), false);
});

/**
 * The /text-lid sample. Verified live against Sarvam: the raw text below returns
 * `en-IN`, and the same text with the page marker removed returns `hi-IN`. The
 * marker is ours, not the document's, and that one wrong answer is what made the
 * pipeline skip translation entirely.
 */
import { lidSample } from "../client";

test("page markers are stripped before language detection", () => {
  const withMarker = `--- page 1 ---\n${REAL_PAGE}`;
  assert.ok(!/--- page/.test(lidSample(withMarker)));
  assert.ok(lidSample(withMarker).startsWith("से अधिक"));
});

test("every page marker is stripped, not just the first", () => {
  const multi = `--- page 1 ---\n${REAL_PAGE}\n\n--- page 2 ---\n${REAL_PAGE}`;
  assert.strictEqual((lidSample(multi).match(/--- page/g) ?? []).length, 0);
});

test("the sample stays within the /text-lid limit", () => {
  assert.ok(lidSample(REAL_PAGE.repeat(50)).length <= 1000);
});

test("marker-only text yields an empty sample rather than a bogus detection", () => {
  assert.strictEqual(lidSample("--- page 1 ---\n\n--- page 2 ---"), "");
});

test("text containing no markers is unchanged", () => {
  assert.strictEqual(lidSample(REAL_PAGE), REAL_PAGE);
});
