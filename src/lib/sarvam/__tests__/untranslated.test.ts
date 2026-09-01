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

/**
 * Bilingual glosses.
 *
 * A 50-page Mathura police case diary is a pre-printed government form whose
 * field labels are bilingual on the page, so a faithful English translation
 * keeps them. Every one of those characters used to count as evidence that the
 * page had not been translated, which sent correct Haiku output to the strong
 * model and made the document cost three passes instead of one.
 *
 * The fixtures below reproduce that document's SHAPE — its public form
 * scaffolding and synthetic narrative in the same proportions. None of the real
 * document's contents appear here: it is a live criminal case diary naming
 * witnesses and their addresses, and that has no place in a repository.
 */
import {
  stripGlosses,
  countScript,
  foreignScriptShare,
  type Script,
} from "../languages";

const DEV: Script = "devanagari";

test("a parenthetical gloss introduced by target text is removed", () => {
  const s = stripGlosses("Date of Action (कार्यवाही की दिनांक)", "latin");
  assert.strictEqual(countScript(s, DEV), 0);
  assert.match(s, /Date of Action/);
});

test("a slash gloss introduced by target text is removed", () => {
  const s = stripGlosses("Case Diary Details / प्रकरण दैनिकी का विवरण", "latin");
  assert.strictEqual(countScript(s, DEV), 0);
  assert.match(s, /Case Diary Details/);
});

test("standalone source-script text is left completely alone", () => {
  // The whole safety argument: nothing introduces these characters, so a real
  // passthrough is scored exactly as before.
  assert.strictEqual(stripGlosses(REAL_PAGE, "latin"), REAL_PAGE);
  assert.strictEqual(stripGlosses(HINDI, "latin"), HINDI);
});

test("stripping can only lower a foreign-script count, never raise it", () => {
  for (const t of [REAL_PAGE, HINDI, ENGLISH, "Sections (धाराएं) 406 / 420"]) {
    assert.ok(countScript(stripGlosses(t, "latin"), DEV) <= countScript(t, DEV));
  }
});

test("glosses are stripped in the other direction for a Devanagari target", () => {
  // Translating INTO Hindi, the gloss is the English one.
  const s = stripGlosses("कार्यवाही (Action Taken)", DEV);
  assert.strictEqual(countScript(s, "latin"), 0);
});

test("a bare parenthetical with no introducing target text is kept", () => {
  const bare = "(४१. संक्रमण तथा उत्तराधिकार कोई सदस्य प्रबन्ध समिति की पूर्व स्वीकृति से)";
  assert.strictEqual(stripGlosses(bare, "latin"), bare);
});

// The form scaffolding a correct translation legitimately preserves.
const FORM_LABELS = [
  "Case Diary Details / प्रकरण दैनिकी का विवरण",
  "Case Diary No. (प्रकरण दैनिकी सं.)",
  "Case Diary Supplementary No. (प्रकरण दैनिकी पूरक सं.)",
  "Date (दिनांक)",
  "FIR No. (सं.)",
  "District (जिला)",
  "1. General Information (सामान्य जानकारी)",
  "a) Date of Preparing the Case Diary (प्रकरण दैनिकी तैयार करने की दिनांक)",
  "b) Start time of Investigation (जांच प्रारंभ समय)",
  "c) End time of Investigation (जांच अंत समय)",
  "d) Places Visited (स्थानों का दौरा किया)",
  "3. Evidence Details (साक्ष्य विवरण)",
  "S.No. (क्र.सं.)",
  "Evidence Type (साक्ष्य के)",
  "Property Recovered Detail (बरामद संपत्ति का विवरण)",
  "Collected On (प्रकृतस्थ दिनांक)",
  "Collected at (प्रकृतस्थ जगह / द्वारा)",
  "4. Action Taken Details (कार्यवाही का विवरण)",
  "a) Action Taken (कार्यवाही)",
  "b) Date of Action (कार्यवाही की दिनांक)",
  "d) Remarks (टिप्पणियाँ)",
  "5. Comments / Instructions of Supervisor (पर्यवेक्षक के निर्देश / टिप्पणी)",
  "Commented By (द्वारा टिप्पणी)",
  "Office Type & Office Name (कार्यालय प्रकार व कार्यालय का नाम)",
  "Date of Print (रिपोर्ट मुद्रण की दिनांक)",
  "Rank (पद)",
  "Name (नाम)",
  "Annexure (संलग्नक)",
  "Sections (धाराएं)",
  "Police Station (थाना)",
];

// Narrative body, correctly rendered into English.
const CASE_NARRATIVE_EN = [
  "Sir, the above case, registered at the present police station, was entrusted to me on the order of the Acting Inspector-in-Charge.",
  "Having obtained copies of the chik report and the registration report from the police station office, I engaged myself in the investigation.",
  "The complainant was examined at length and his statement was recorded in accordance with the provisions of the Code of Criminal Procedure.",
  "The scene of occurrence was inspected and a site plan was prepared with the assistance of the local witnesses present there.",
  "I, the Investigating Officer, have other government duties and therefore the remaining investigation could not be completed on this date.",
];

// The same body left in the source language — a genuine passthrough.
const CASE_NARRATIVE_HI = [
  "श्रीमान, उपरोक्त मुकदमा जो वर्तमान थाने पर पंजीकृत है, प्रभारी निरीक्षक महोदय के आदेश से मुझे विवेचना हेतु प्राप्त हुआ।",
  "थाना कार्यालय से चिक रिपोर्ट तथा पंजीकरण रिपोर्ट की प्रतियां प्राप्त कर मैं विवेचना में संलग्न हुआ।",
  "वादी मुकदमा से विस्तृत पूछताछ की गई तथा उसका बयान दंड प्रक्रिया संहिता के प्रावधानों के अनुसार अंकित किया गया।",
  "घटनास्थल का निरीक्षण किया गया तथा वहां उपस्थित स्थानीय गवाहों की सहायता से नक्शा नजरी तैयार किया गया।",
  "मैं विवेचक अधिकारी अन्य राजकीय कार्यों में व्यस्त रहा, अतः शेष विवेचना इस दिनांक को पूर्ण नहीं की जा सकी।",
];

const repeat = <T,>(xs: T[], n: number): T[] => Array.from({ length: n }, () => xs).flat();
const caseDiaryPage = (narrative: string[]) =>
  block(...repeat([...FORM_LABELS, ...narrative], 6));

test("the case-diary fixture really does exercise the bug", () => {
  // Pins the premise: on a naive whole-text census this correct translation
  // scores far above UNTRANSLATED_OUTPUT_SHARE (0.15). Without this the
  // regression test below could pass for the wrong reason.
  const text = repeat([...FORM_LABELS, ...CASE_NARRATIVE_EN], 6).join(" ");
  const naive = foreignScriptShare(text, "en-IN");
  assert.ok(naive !== null && naive > 0.15, `expected >0.15, got ${naive}`);
});

test("a correctly translated bilingual form is not escalated", () => {
  assert.strictEqual(
    batchLooksUntranslated(caseDiaryPage(CASE_NARRATIVE_EN), "English"),
    false
  );
});

test("the same form left untranslated is still escalated", () => {
  assert.ok(batchLooksUntranslated(caseDiaryPage(CASE_NARRATIVE_HI), "English"));
});

/**
 * The relative check. It is consulted only for a batch that already tripped the
 * absolute bar, and it can only ever clear one — so it cannot introduce a new
 * escalation, only withdraw an unjustified one.
 */
const mixedSource = repeat([...FORM_LABELS, ...CASE_NARRATIVE_HI], 6).join(" ");

test("a large density drop against a script-mixed source is not escalated", () => {
  assert.strictEqual(
    batchLooksUntranslated(caseDiaryPage(CASE_NARRATIVE_EN), "English", mixedSource),
    false
  );
});

test("a passthrough of a script-mixed source is still escalated", () => {
  assert.ok(
    batchLooksUntranslated(caseDiaryPage(CASE_NARRATIVE_HI), "English", mixedSource)
  );
});

test("a half-translated batch is still escalated", () => {
  const half = [...CASE_NARRATIVE_EN.slice(0, 2), ...CASE_NARRATIVE_HI.slice(2)];
  assert.ok(batchLooksUntranslated(caseDiaryPage(half), "English", mixedSource));
});

test("the relative check never re-flags a batch that cleared the absolute bar", () => {
  // Source is pure English; a clean English translation must stay clean even
  // though there is no density to drop from.
  const clean = block(...CASE_NARRATIVE_EN);
  assert.strictEqual(
    batchLooksUntranslated(clean, "English", CASE_NARRATIVE_EN.join(" ")),
    false
  );
});

/**
 * The chunk-level detector has the same blind spot: the real chunk that failed
 * was a bilingual table header, where a correct translation keeps every gloss
 * and the surviving-script ratio approaches 1.
 */
const TABLE_HI =
  "<table><thead><tr><th>S.No. (क्र.सं.)</th><th>Evidence Type (साक्ष्य के)</th>" +
  "<th>Property Recovered Detail (बरामद संपत्ति का विवरण)</th></tr></thead>" +
  "<tbody><tr><td>1</td><td>दस्तावेजी साक्ष्य जो विवेचना के दौरान संकलित किया गया</td>" +
  "<td>घटनास्थल से बरामद कागजात की छायाप्रति संलग्न है</td></tr></tbody></table>";
const TABLE_EN =
  "<table><thead><tr><th>S.No. (क्र.सं.)</th><th>Evidence Type (साक्ष्य के)</th>" +
  "<th>Property Recovered Detail (बरामद संपत्ति का विवरण)</th></tr></thead>" +
  "<tbody><tr><td>1</td><td>Documentary evidence collected during the investigation</td>" +
  "<td>A photocopy of the papers recovered from the scene is enclosed</td></tr></tbody></table>";

test("a translated bilingual table is not called an echo", () => {
  assert.strictEqual(isUntranslated(TABLE_HI, TABLE_EN, HI, EN), false);
});

test("an echoed bilingual table is still caught", () => {
  assert.ok(isUntranslated(TABLE_HI, TABLE_HI, HI, EN));
});

test("a bilingual table with its body left in the source is still caught", () => {
  const bodyUntouched = TABLE_EN.replace(
    "Documentary evidence collected during the investigation",
    "दस्तावेजी साक्ष्य जो विवेचना के दौरान संकलित किया गया"
  ).replace(
    "A photocopy of the papers recovered from the scene is enclosed",
    "घटनास्थल से बरामद कागजात की छायाप्रति संलग्न है"
  );
  assert.ok(isUntranslated(TABLE_HI, bodyUntouched, HI, EN));
});
