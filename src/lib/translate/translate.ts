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

function buildPrompt(targetLanguage: string): string {
  return `You are a meticulous legal translator and document-structure parser for Indian legal documents.

You are given a legal/official document. In ONE pass:
1. Read every word — including faded typewriter ink, handwriting, stamps, seals, and marginalia. Use surrounding legal context to resolve degraded characters; never invent content.
2. Translate everything faithfully into ${targetLanguage}, preserving legal meaning, and reproduce the document's STRUCTURE as typed blocks.

Output ONLY a JSON object (no prose, no code fences) of this exact shape:
{"detected_language": "<source language name>", "blocks": [ <block>, ... ]}

Each <block> is exactly one of:
- {"type":"heading","level":1|2|3,"runs":[<run>]}              // court name (level 1), section titles like "Order", "Present:" (level 2/3)
- {"type":"paragraph","number":"<original number e.g. 1.>"|null,"runs":[<run>]}  // body paragraphs; keep the ORIGINAL numbering, never renumber
- {"type":"kv","rows":[{"key":"<label>","value":[<run>]}]}     // a label:value block such as the cause-title (Presiding Officer, Bail Application No., C.I.S., C.N.R.)
- {"type":"table","header":["<col>",...],"rows":[[[<run>],...],...]}  // real tables, e.g. the prior-bail-applications footnote table
- {"type":"partyLabel","runs":[<run>]}                          // party designations like "--- Applicant-Accused", "--- Non-Applicant", "Versus"
- {"type":"signature","runs":[<run>]}                           // signatory block (judge name + designation)

Each <run> is {"text":"<translated text>","italic":<bool>,"bold":<bool>,"flagged":<bool>,"note":<string|null>}.

Rules:
- Set "italic":true on case citations / case names (e.g. Prabir Purkayastha Vs State (NCT of Delhi)).
- Reproduce ALL numbers, dates, FIR/case numbers, statute section numbers, phone numbers, IMEI/IDs and proper names EXACTLY. Transliterate names; if unsure of a spelling, set "flagged":true.
- Keep each paragraph's original number in "number" (e.g. "1.", "2."). Use null when a paragraph has no number.
- If any span is illegible, ambiguous, cut off, or in a script you cannot confidently read, set "flagged":true on that run and explain in "note". Give your best-effort text but NEVER guess at unreadable content — a flagged gap is far safer than a confident wrong translation.
- Emit the content ONCE in natural reading order. Do NOT repeat running page-headers/footers that appear on every page.
- Do not summarise, add commentary, or omit anything.`;
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
    () => buildPrompt(targetLanguage),
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

/** Per-batch vision config for the durable-queue worker (translate: default
 *  model, no schema — the stronger model + detailed prompt suffice). */
export function translateBatchConfig(targetLanguage: string): {
  prompt: string;
  model: string | undefined;
  schema: Record<string, unknown> | null;
  feature: string;
} {
  return { prompt: buildPrompt(targetLanguage), model: undefined, schema: null, feature: "translate" };
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
