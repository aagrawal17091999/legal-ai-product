/**
 * Legal document translation (Feature 2) — vision-native, structure-preserving.
 *
 * Unlike a flat OCR→text→translate chain (which discards all layout before
 * translation even begins), this sends the SOURCE document straight to a vision
 * model and does OCR + translation + structuring in ONE pass. The model sees the
 * actual page (faded ink, handwriting, stamps) and reasons about degraded
 * characters using legal context, emitting a typed block model (see model.ts)
 * with the translation already done.
 *
 * The heavy lifting (PDF batching, bounded-concurrency vision calls, JSON
 * parsing, block coercion) lives in src/lib/vision/structured.ts and is shared
 * with the OCR feature; this module only supplies the translation prompt and
 * wraps the result into a TranslationResult.
 *
 * Source language is auto-detected; the target language is user-selected. Each
 * run carries a `flagged` flag — when the model cannot confidently read part of
 * the source it flags that span rather than guessing.
 */

import {
  assembleBlocks,
  type ParsedBatch,
} from "../vision/structured";
import {
  type TranslationResult,
  countFlagged,
  flattenToSegments,
} from "./model";
import {
  languageCode,
  foreignScriptShare,
  scriptOf,
  stripGlosses,
} from "../sarvam/languages";

/**
 * How much work Claude still has to do for this unit, which depends on how far
 * Sarvam got. Getting the framing right matters: telling a model to "read faded
 * ink" when it was handed plain text invites hallucinated corrections, and
 * telling it to "translate" text that is already translated invites a damaging
 * second pass over legal wording.
 */
export type TranslateMode =
  /** Nothing pre-processed: Claude reads the pixels, translates and structures. */
  | "vision"
  /** Sarvam read the pages: Claude translates the extracted text and structures it. */
  | "text"
  /** Sarvam read AND translated: Claude only structures the translated prose. */
  | "pretranslated";

function buildPrompt(targetLanguage: string, mode: TranslateMode): string {
  const role =
    mode === "pretranslated"
      ? `You are a meticulous document-structure parser for Indian legal documents.`
      : `You are a meticulous legal translator and document-structure parser for Indian legal documents.`;

  const intro =
    mode === "pretranslated"
      ? `You are given the text of a legal/official document that has ALREADY been translated into ${targetLanguage} by a machine translation system. The text was OCR'd from a scan first, so it may contain both OCR errors and translation artefacts. Lines of the form "--- page N ---" mark page boundaries; they are NOT document content.
0. The OCR engine that produced the source sometimes DESCRIBED a picture instead of transcribing text (e.g. a sentence about "an image containing no text"). Such descriptions are not part of the document. OMIT them entirely.
1. Do NOT re-translate, rewrite, improve, summarise or correct wording that IS in ${targetLanguage}. Reproduce it as given — it is the translation of record.
2. Your job is to reproduce the document's STRUCTURE as typed blocks, assigning each span of the existing text to the right block type.
3. EXCEPTION — untranslated spans. The upstream translator sometimes returns a passage unchanged, so parts of the text may still be in the SOURCE language. Translate those spans into ${targetLanguage} yourself and set "flagged":true with a note saying the span was translated here because it arrived untranslated. This is the one case where you may change wording: a reviewer can check a flagged translation, but source-language text in the output is unusable.
4. The upstream translator also sometimes prefixes a conversational line such as "Here is the translation of the Hindi text to English:". That is the machine talking, not document content. OMIT such lines entirely.`
      : mode === "text"
        ? `You are given the raw text of a legal/official document as produced by an OCR engine reading a scan or photo. It may contain OCR errors: garbled words, split or merged characters, mangled table layout, and fragments in the wrong order. Lines of the form "--- page N ---" mark page boundaries; they are NOT document content.
0. The OCR engine sometimes DESCRIBES a picture instead of transcribing text — e.g. "This image contains no text. It is a black silhouette of an object…". Such descriptions are the engine talking about the page, not words printed on it. OMIT them entirely; never translate them as document content.
1. Work only from the text given. Use surrounding legal context to recognise what a garbled span was meant to be, but NEVER invent content that isn't there.
2. Translate everything faithfully into ${targetLanguage}, preserving legal meaning, and reproduce the document's STRUCTURE as typed blocks.`
        : `You are given a legal/official document. In ONE pass:
1. Read every word — including faded typewriter ink, handwriting, stamps, seals, and marginalia. Use surrounding legal context to resolve degraded characters; never invent content.
2. Translate everything faithfully into ${targetLanguage}, preserving legal meaning, and reproduce the document's STRUCTURE as typed blocks.`;

  return `${role}

${intro}

Output ONLY a JSON object (no prose, no code fences) of this exact shape:
{"detected_language": "<source language name>", "blocks": [ <block>, ... ]}

Each <block> is exactly one of:
- {"type":"heading","level":1|2|3,"runs":[<run>]}              // court name (level 1), section titles like "Order", "Present:" (level 2/3)
- {"type":"paragraph","number":"<original number e.g. 1.>"|null,"runs":[<run>]}  // body paragraphs; keep the ORIGINAL numbering, never renumber
- {"type":"kv","rows":[{"key":"<label>","value":[<run>]}]}     // a label:value block such as the cause-title (Presiding Officer, Bail Application No., C.I.S., C.N.R.)
- {"type":"table","header":["<col>",...],"rows":[[[<run>],...],...]}  // real tables, e.g. the prior-bail-applications footnote table
- {"type":"partyLabel","runs":[<run>]}                          // party designations like "--- Applicant-Accused", "--- Non-Applicant", "Versus"
- {"type":"signature","runs":[<run>]}                           // signatory block (judge name + designation)

Each <run> is {"text":"<${mode === "pretranslated" ? "text exactly as given" : "translated text"}>","italic":<bool>,"bold":<bool>,"flagged":<bool>,"note":<string|null>}.

Rules:
- Set "italic":true on case citations / case names (e.g. Prabir Purkayastha Vs State (NCT of Delhi)).
- Reproduce ALL numbers, dates, FIR/case numbers, statute section numbers, phone numbers, IMEI/IDs and proper names EXACTLY${mode === "pretranslated" ? "." : ". Transliterate names; if unsure of a spelling, set \"flagged\":true."}
- Keep each paragraph's original number in "number" (e.g. "1.", "2."). Use null when a paragraph has no number.
- ${
    mode === "pretranslated"
      ? `If any span is garbled, nonsensical or truncated, set "flagged":true on that run and explain in "note". Do NOT repair garbled ${targetLanguage} — copy it through as given and flag it; a flagged span the reviewer can check is far safer than a silent rewrite of legal wording. Text still in the source language is the exception covered by rule 3: translate it, and flag it.`
      : mode === "text"
        ? `If any span is garbled, nonsensical, truncated, or otherwise looks like an OCR failure, set "flagged":true on that run and explain in "note". Give your best-effort translation but NEVER smooth over a corrupted span into plausible-looking prose — a flagged gap is far safer than a confident wrong translation.`
        : `If any span is illegible, ambiguous, cut off, or in a script you cannot confidently read, set "flagged":true on that run and explain in "note". Give your best-effort text but NEVER guess at unreadable content — a flagged gap is far safer than a confident wrong translation.`
  }
- Emit the content ONCE in natural reading order. Do NOT repeat running page-headers/footers that appear on every page${mode === "vision" ? "" : ", and never emit the \"--- page N ---\" markers themselves"}.
- Do not summarise, add commentary, or omit anything.${
    mode === "pretranslated"
      ? `\n- "detected_language" is not something you can tell from this text; output "Unknown" for it.`
      : ""
  }`;
}

/**
 * Model for the Claude step once Sarvam has pre-read the page.
 *
 * Haiku is the default for both text modes because it is ~5x cheaper on output
 * tokens and output dominates this workload. It is NOT reliably able to
 * translate, though: on the Hindi bylaws scan that exposed this, Haiku in `text`
 * mode returned all 2,434 Devanagari characters untranslated while dutifully
 * structuring them, where Sonnet returned zero. So the cheap tier is used
 * speculatively and its OUTPUT is checked — see `batchLooksUntranslated`, which
 * escalates that batch to the strong model. Cheap when it works, correct when it
 * doesn't; the vision path keeps the strong model outright, since reading faded
 * ink is perception and Haiku was measurably bad at it.
 */
const TRANSLATE_TEXT_MODEL =
  process.env.TRANSLATE_TEXT_MODEL?.trim() || "claude-haiku-4-5";

/**
 * Above this share of non-target-script letters, a batch's output is treated as
 * untranslated. A genuine translation scores near zero (the verified Sonnet run
 * on the bylaws page left 1 Devanagari character in ~3,000), so this sits far
 * above the transliteration noise floor and far below a passthrough.
 *
 * The census is taken AFTER {@link stripGlosses}, so bilingual field labels a
 * faithful translation keeps ("Sections (धाराएं)") no longer count against it.
 */
const UNTRANSLATED_OUTPUT_SHARE = 0.15;

/**
 * How much of the INPUT's foreign-script density may survive into the output
 * before a batch that already tripped {@link UNTRANSLATED_OUTPUT_SHARE} is still
 * called untranslated.
 *
 * This is the second opinion for documents that are inherently script-mixed, and
 * it only ever RESCUES: a batch under the absolute threshold is never re-flagged
 * by it. The failure being caught is wholesale passthrough, where output density
 * matches input (ratio ≈ 1); a real translation collapses it toward zero. A
 * half-translated page lands near 0.5 and must still be caught, so the bar sits
 * below that, matching the chunk-level UNTRANSLATED_RATIO in sarvam/client.ts.
 */
const RETAINED_DENSITY_RATIO = 0.25;

/** Collect every human-readable string out of a raw parsed batch. */
function collectText(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectText(v, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "text" || key === "key") && typeof v === "string") out.push(v);
    else collectText(v, out);
  }
}

/**
 * Whether a batch came back structured but not translated.
 *
 * Checked on the cheap tier's output so the pipeline can escalate to the strong
 * model instead of shipping the source language to the user. Deliberately
 * script-based: it needs no second model call, and the failure it catches is
 * always a wholesale passthrough rather than a subtle mistranslation.
 *
 * `sourceText` is the text the model was given (Sarvam's OCR or its
 * translation). When supplied it enables the relative check described at
 * {@link RETAINED_DENSITY_RATIO}, which is what keeps heavily bilingual sources
 * off the escalation path. It is optional so the vision mode, which has no text
 * input, still gets the absolute check.
 */
export function batchLooksUntranslated(
  parsed: ParsedBatch,
  targetLanguage: string,
  sourceText?: string | null
): boolean {
  const code = languageCode(targetLanguage);
  if (!parsed || !code) return false;
  const script = scriptOf(code);
  if (!script) return false;

  const out: string[] = [];
  collectText(parsed, out);
  const share = foreignScriptShare(stripGlosses(out.join(" "), script), code);
  if (share == null || share <= UNTRANSLATED_OUTPUT_SHARE) return false;

  // Over the absolute bar. If we know what went in, a big density drop still
  // means the model did the work — the source was simply script-mixed to begin
  // with. Comparing like with like: both sides are gloss-stripped.
  if (sourceText) {
    const inShare = foreignScriptShare(stripGlosses(sourceText, script), code);
    if (inShare != null && inShare > 0) {
      return share / inShare > RETAINED_DENSITY_RATIO;
    }
  }
  return true;
}

/** Per-batch config for the durable-queue worker. No structured-output schema —
 *  the detailed prompt + robust parsing suffice (see vision/structured.ts).
 *
 *  @param mode how much Sarvam already did for this unit. */
export function translateBatchConfig(
  targetLanguage: string,
  mode: TranslateMode = "vision"
): {
  prompt: string;
  model: string | undefined;
  schema: Record<string, unknown> | null;
  feature: string;
} {
  return {
    prompt: buildPrompt(targetLanguage, mode),
    // undefined = the strong default (Sonnet) resolved in vision/structured.ts.
    model: mode === "vision" ? undefined : TRANSLATE_TEXT_MODEL,
    schema: null,
    feature: "translate",
  };
}

/** Assemble per-batch results (in reading order) into the final TranslationResult. */
export function assembleTranslationResult(
  parsed: ParsedBatch[],
  kind: "pdf" | "image" | "text",
  targetLanguage: string
): TranslationResult {
  const { detectedLanguage, blocks, ocrUsed } = assembleBlocks(parsed, kind);
  return {
    detectedLanguage,
    targetLanguage,
    blocks,
    segments: flattenToSegments(blocks),
    flaggedCount: countFlagged(blocks),
    ocrUsed,
  };
}
