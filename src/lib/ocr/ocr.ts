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

import { runStructuredVisionPass } from "../vision/structured";
import {
  type Block,
  type TranslatedSegment,
  countFlagged,
  flattenToSegments,
} from "../translate/model";

// OCR runs on Haiku by default — far cheaper, and adequate for transcription on
// reasonable scans. Override with OCR_MODEL (e.g. a Sonnet/Opus tier) for hard,
// faded, or heavily non-Latin documents. Translation stays on the stronger
// DEFAULT_MODEL — this override is OCR-only.
const OCR_MODEL = process.env.OCR_MODEL?.trim() || "claude-haiku-4-5";

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

function buildPrompt(): string {
  return `You are a meticulous OCR and document-structure parser for Indian legal/official documents.

You are given a document (often a scan, photo, or faded typewritten/handwritten page). In ONE pass:
1. Read every word — including faded typewriter ink, handwriting, stamps, seals, and marginalia. Use surrounding legal context to resolve degraded characters; never invent content.
2. Transcribe everything EXACTLY as written, in its ORIGINAL language and script. Do NOT translate, modernise, correct, or paraphrase anything. Reproduce the document's STRUCTURE as typed blocks.

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
- If any span is illegible, ambiguous, cut off, or in a script you cannot confidently read, set "flagged":true on that run and explain in "note". Give your best-effort text but NEVER guess at unreadable content — a flagged gap is far safer than a confident wrong transcription.
- Emit the content ONCE in natural reading order. Do NOT repeat running page-headers/footers that appear on every page.
- Do not summarise, add commentary, or omit anything.`;
}

export async function ocrDocumentStructured(
  buffer: Buffer,
  mime: string,
  filename: string
): Promise<OcrResult> {
  const { detectedLanguage, blocks, ocrUsed } = await runStructuredVisionPass(
    buffer,
    mime,
    filename,
    buildPrompt,
    "ocr",
    OCR_MODEL
  );

  return {
    detectedLanguage,
    blocks,
    segments: flattenToSegments(blocks),
    flaggedCount: countFlagged(blocks),
    ocrUsed,
  };
}
