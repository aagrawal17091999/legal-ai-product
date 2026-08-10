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
  runStructuredVisionPass,
  assembleBlocks,
  type ParsedBatch,
} from "../vision/structured";
import {
  type TranslationResult,
  countFlagged,
  flattenToSegments,
} from "./model";

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
1. Do NOT re-translate, rewrite, improve, summarise or correct the wording. Reproduce the text as given — it is the translation of record.
2. Your ONLY job is to reproduce the document's STRUCTURE as typed blocks, assigning each span of the existing text to the right block type.`
      : mode === "text"
        ? `You are given the raw text of a legal/official document as produced by an OCR engine reading a scan or photo. It may contain OCR errors: garbled words, split or merged characters, mangled table layout, and fragments in the wrong order. Lines of the form "--- page N ---" mark page boundaries; they are NOT document content.
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
      ? `If any span is garbled, nonsensical, truncated, or reads like a broken machine translation, set "flagged":true on that run and explain in "note". Do NOT repair it — copy it through as given and flag it. A flagged span the reviewer can check is far safer than a silent rewrite of legal wording.`
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

export async function translateDocumentStructured(
  buffer: Buffer,
  mime: string,
  filename: string,
  targetLanguage: string
): Promise<TranslationResult> {
  const { detectedLanguage, blocks, ocrUsed } = await runStructuredVisionPass(
    buffer,
    mime,
    filename,
    () => buildPrompt(targetLanguage, "vision"),
    "translate"
  );

  const segments = flattenToSegments(blocks);

  return {
    detectedLanguage,
    targetLanguage,
    blocks,
    segments,
    flaggedCount: countFlagged(blocks),
    ocrUsed,
  };
}

/**
 * Model for the Claude step, chosen by how much work is left.
 *
 * Vision keeps the strong model: reading faded typewriter ink and handwriting off
 * a scan is perception, and Haiku was measurably bad at it (empty-runs paragraphs
 * and malformed blocks on real legal scans). Once Sarvam has done the reading —
 * and, in `pretranslated` mode, the translating — what remains is parsing prose
 * into typed blocks, which is well within Haiku and ~5x cheaper on output tokens
 * (output dominates this workload). Both are env-overridable so the tiers can be
 * moved independently once real output is compared.
 */
const TRANSLATE_TEXT_MODEL =
  process.env.TRANSLATE_TEXT_MODEL?.trim() || "claude-haiku-4-5";

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
    // undefined = the vision default (Sonnet) resolved in vision/structured.ts.
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
