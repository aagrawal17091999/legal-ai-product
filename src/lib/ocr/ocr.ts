/**
 * Document OCR — vision-native, structure-preserving.
 *
 * Same single-pass vision pipeline as the translation feature, but it TRANSCRIBES
 * instead of translating: the model reads the source (faded ink, handwriting,
 * stamps) and emits the text exactly as written, in its original language,
 * reproducing the document's structure as a typed block model (see
 * ../translate/model.ts). The result is rendered to a clean PDF (+ DOCX).
 *
 * The heavy lifting is shared with translation via ../vision/structured.ts; this
 * module only supplies the transcription prompt and wraps the result.
 */

import {
  assembleBlocks,
  type ParsedBatch,
} from "../vision/structured";
import {
  type Block,
  type TranslatedSegment,
  countFlagged,
  flattenToSegments,
} from "../translate/model";

// Two tiers, picked by how much work is left for Claude.
//
// VISION (Sarvam unavailable, Claude reads the pixels itself) stays on Sonnet:
// Haiku proved too weak/variable at READING real legal scans — empty-runs
// paragraphs and malformed blocks, e.g. empty kv rows that crashed the docx
// render. That finding was about perception, not parsing.
//
// TEXT (Sarvam already read the page) runs on Haiku: turning prose into typed
// blocks is well within it, and output tokens — which dominate this workload —
// are 5x cheaper. Override either independently once real output is compared.
const OCR_VISION_MODEL = process.env.OCR_MODEL?.trim() || "claude-sonnet-4-6";
const OCR_TEXT_MODEL = process.env.OCR_TEXT_MODEL?.trim() || "claude-haiku-4-5";

/** The stored OCR result. Shares the block model with translation; `segments`
 *  is the flattened projection the in-app viewer + segment_count column use. */
export interface OcrResult {
  detectedLanguage: string;
  blocks: Block[];
  segments: TranslatedSegment[];
  flaggedCount: number;
  /** True when a vision pass read the source pixels/PDF (vs. a DOCX text path). */
  ocrUsed: boolean;
}

/**
 * @param fromOcrText true when the input is Markdown that Sarvam Doc AI already
 *   extracted from the page, rather than the page pixels themselves. The two
 *   modes need different framing: reading a scan is an act of perception, while
 *   structuring OCR output is an act of parsing text that may already be wrong.
 *   Getting this wrong matters — a prompt that tells the model to "read faded
 *   ink" when handed plain text invites it to hallucinate corrections.
 */
function buildPrompt(fromOcrText: boolean): string {
  const intro = fromOcrText
    ? `You are given the raw text of a document as produced by an OCR engine reading a scan or photo. It may contain OCR errors: garbled words, split or merged characters, mangled table layout, and fragments in the wrong order. Lines of the form "--- page N ---" mark page boundaries; they are NOT document content.
0. The OCR engine sometimes DESCRIBES a picture instead of transcribing text — e.g. "This image contains no text. It is a black silhouette of an object…". Such descriptions are the engine talking about the page, not words printed on it. OMIT them entirely; never transcribe them as document content.
1. Work only from the text given. Use surrounding legal context to recognise what a garbled span was meant to be, but NEVER invent content that isn't there.
2. Reproduce everything EXACTLY as it appears, in its ORIGINAL language and script. Do NOT translate, modernise, correct, or paraphrase anything. Reproduce the document's STRUCTURE as typed blocks.`
    : `You are given a document (often a scan, photo, or faded typewritten/handwritten page). In ONE pass:
1. Read every word — including faded typewriter ink, handwriting, stamps, seals, and marginalia. Use surrounding legal context to resolve degraded characters; never invent content.
2. Transcribe everything EXACTLY as written, in its ORIGINAL language and script. Do NOT translate, modernise, correct, or paraphrase anything. Reproduce the document's STRUCTURE as typed blocks.`;

  return `You are a meticulous OCR and document-structure parser for Indian legal/official documents.

${intro}

Output ONLY a JSON object (no prose, no code fences) of this exact shape:
{"detected_language": "<the document's language name>", "blocks": [ <block>, ... ]}

Each <block> is exactly one of:
- {"type":"heading","level":1|2|3,"runs":[<run>]}              // court name (level 1), section titles like "Order", "Present:" (level 2/3)
- {"type":"paragraph","number":"<original number e.g. 1.>"|null,"runs":[<run>]}  // body paragraphs; keep the ORIGINAL numbering, never renumber
- {"type":"kv","rows":[{"key":"<label>","value":[<run>]}]}     // a label:value block such as the cause-title (Presiding Officer, Bail Application No., C.I.S., C.N.R.)
- {"type":"table","header":["<col>",...],"rows":[[[<run>],...],...]}  // real tables
- {"type":"partyLabel","runs":[<run>]}                          // party designations like "--- Applicant-Accused", "--- Non-Applicant", "Versus"
- {"type":"signature","runs":[<run>]}                           // signatory block (judge name + designation)

Each <run> is {"text":"<transcribed text>","italic":<bool>,"bold":<bool>,"flagged":<bool>,"note":<string|null>}.

Rules:
- Transcribe in the source language/script — never translate or transliterate.
- Set "italic":true on case citations / case names where the source italicises or underlines them.
- Reproduce ALL numbers, dates, FIR/case numbers, statute section numbers, phone numbers, IMEI/IDs and proper names EXACTLY as written.
- Keep each paragraph's original number in "number" (e.g. "1.", "2."). Use null when a paragraph has no number.
- ${
    fromOcrText
      ? `If any span is garbled, nonsensical, truncated, or otherwise looks like an OCR failure, set "flagged":true on that run and explain in "note". Give your best-effort text but NEVER smooth over a corrupted span into plausible-looking prose — a flagged gap is far safer than a confident wrong transcription.`
      : `If any span is illegible, ambiguous, cut off, or in a script you cannot confidently read, set "flagged":true on that run and explain in "note". Give your best-effort text but NEVER guess at unreadable content — a flagged gap is far safer than a confident wrong transcription.`
  }
- Emit the content ONCE in natural reading order. Do NOT repeat running page-headers/footers that appear on every page${fromOcrText ? ", and never emit the \"--- page N ---\" markers themselves" : ""}.
- Do not summarise, add commentary, or omit anything.`;
}

/** Per-batch config for the durable-queue worker. No structured-output schema:
 *  it backfired. The full typed block schema is rejected by the API ("grammar
 *  too large"), and a loose schema makes the model emit `runs` as a scalar
 *  (" "/null) instead of an array — producing empty transcriptions. Sonnet plus
 *  the detailed prompt returns clean, valid JSON on its own (the parser strips
 *  any code fence), so we rely on that + coerceBlock.
 *
 *  @param fromOcrText true when Sarvam already extracted the text for this unit. */
export function ocrBatchConfig(fromOcrText = false): {
  prompt: string;
  model: string;
  schema: Record<string, unknown> | null;
  feature: string;
} {
  return {
    prompt: buildPrompt(fromOcrText),
    model: fromOcrText ? OCR_TEXT_MODEL : OCR_VISION_MODEL,
    schema: null,
    feature: "ocr",
  };
}

/** Assemble per-batch results (in reading order) into the final OcrResult. */
export function assembleOcrResult(
  parsed: ParsedBatch[],
  kind: "pdf" | "image" | "text"
): OcrResult {
  const { detectedLanguage, blocks, ocrUsed } = assembleBlocks(parsed, kind);
  return {
    detectedLanguage,
    blocks,
    segments: flattenToSegments(blocks),
    flaggedCount: countFlagged(blocks),
    ocrUsed,
  };
}
