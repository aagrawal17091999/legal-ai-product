/**
 * Shared document text-extraction module — used by BOTH the Document Workspace
 * (Feature 1) and Legal Translation (Feature 2).
 *
 * Strategy (Claude-vision-first, per the build decision): try the cheap path
 * first — read a PDF's embedded text layer or a DOCX's text — and only fall
 * back to a Claude vision call when there is no usable text (scanned PDFs,
 * images). This mirrors the offline pipeline (pipeline/pdf_ocr.py) at request
 * time. The OCR detection thresholds are ported verbatim so behaviour matches.
 */

import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { extractPdfWithVision, extractImageWithVision } from "./vision";
import { cleanPages } from "./clean";
import type { SourcePage } from "./chunk";

export type ExtractKind = "pdf" | "docx" | "image";

export interface ExtractResult {
  /** Full document text, pages joined. */
  text: string;
  /** Per-page text (PDF with text layer); single entry for DOCX/image/OCR. */
  pages: SourcePage[];
  pageCount: number;
  /** True when a Claude vision call produced the text (scan/image). */
  ocrUsed: boolean;
  charCount: number;
  kind: ExtractKind;
}

// Ported from pipeline/pdf_ocr.py needs_ocr(): an embedded text layer is "real"
// only if it has enough characters. Below these floors we treat it as a scan.
//
// IMPORTANT: count LEGIBLE characters (letters + digits, any script), not just
// non-whitespace. Scanned court PDFs frequently carry a text layer that is
// either whitespace-heavy OR pure garbage — e.g. a scan whose embedded font has
// no ToUnicode map extracts every glyph as the control char U+0001. Such a layer
// can hold thousands of "characters" while containing zero readable text. Counting
// only letters/digits makes both cases score ~0 and correctly route to OCR
// instead of feeding an unreadable layer to translation.
const MIN_TOTAL_CHARS = 500;
const MIN_CHARS_PER_PAGE = 50;

/** Count of legible characters (letters or digits, any script) in extracted text. */
export function meaningfulCharCount(text: string): number {
  const m = (text || "").match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

export function needsOcr(text: string, pageCount: number): boolean {
  const chars = meaningfulCharCount(text);
  if (chars === 0) return true;
  if (chars < MIN_TOTAL_CHARS) return true;
  if (pageCount > 0 && chars / pageCount < MIN_CHARS_PER_PAGE) return true;
  return false;
}

const IMAGE_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/** Decide the document kind from MIME type, falling back to the filename. */
export function detectKind(mime: string, filename: string): ExtractKind {
  const m = (mime || "").toLowerCase();
  const name = (filename || "").toLowerCase();
  if (m === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  )
    return "docx";
  if (IMAGE_MIME.has(m) || /\.(jpe?g|png|webp)$/.test(name)) return "image";
  // Default to PDF handling (text-layer probe → vision fallback) for unknowns.
  return "pdf";
}

function imageMediaType(mime: string, filename: string): string {
  const m = (mime || "").toLowerCase();
  if (IMAGE_MIME.has(m)) return m === "image/jpg" ? "image/jpeg" : m;
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "image/jpeg";
}

/**
 * Build an ExtractResult from raw per-page text, running the boilerplate
 * cleaner (signature stamps, running headers/footers) before deriving the
 * joined text and char count so retrieval, chunking and the corpus-size budget
 * all see the cleaned text.
 */
function finalize(
  rawPages: SourcePage[],
  pageCount: number,
  ocrUsed: boolean,
  kind: ExtractKind
): ExtractResult {
  const pages = cleanPages(rawPages);
  const text = pages.map((p) => p.text).join("\n\n").trim();
  return { text, pages, pageCount, ocrUsed, charCount: text.length, kind };
}

/**
 * Extract text from an uploaded document. Throws on unrecoverable failures so
 * the caller can mark the document/job `failed`.
 */
export async function extractDocument(
  buffer: Buffer,
  mime: string,
  filename: string
): Promise<ExtractResult> {
  const kind = detectKind(mime, filename);

  if (kind === "image") {
    const text = (await extractImageWithVision(buffer, imageMediaType(mime, filename))).trim();
    return finalize([{ page: 1, text }], 1, true, kind);
  }

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer });
    const text = (value || "").trim();
    return finalize([{ page: 1, text }], 1, false, kind);
  }

  // PDF: read the embedded text layer, decide whether OCR is needed.
  const data = new Uint8Array(buffer);
  let pageCount = 0;
  let perPage: string[] = [];
  try {
    const pdf = await getDocumentProxy(data);
    pageCount = pdf.numPages;
    const extracted = await extractText(pdf, { mergePages: false });
    perPage = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
  } catch {
    // Corrupt/unsupported text layer — fall through to OCR.
    perPage = [];
  }

  const layerText = perPage.join("\n\n").trim();

  const ocr = needsOcr(layerText, pageCount);
  // Diagnostic: lets us confirm scans correctly route to OCR rather than feeding
  // a whitespace-only text layer to translation.
  console.info(
    `[extract] pdf "${filename}" pages=${pageCount} rawLen=${layerText.length} ` +
      `meaningfulLen=${meaningfulCharCount(layerText)} ocrUsed=${ocr}`
  );

  if (!ocr) {
    const pages: SourcePage[] = perPage.map((t, i) => ({ page: i + 1, text: t }));
    return finalize(pages, pageCount, false, kind);
  }

  // Scanned PDF → vision OCR. Page boundaries aren't recoverable from the OCR
  // text, so we report a single page with page_no = null downstream.
  const ocrText = (await extractPdfWithVision(buffer, pageCount || 1)).trim();
  return finalize([{ page: null, text: ocrText }], pageCount || 1, true, kind);
}
