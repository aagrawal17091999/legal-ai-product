/**
 * Page-range selection for OCR.
 *
 * A single serverless invocation can only OCR so many pages before the 300s
 * function limit (see ../vision/structured.ts MAX_TOTAL_PAGES), so for a large
 * filing the user picks the pages they actually need. We subset the PDF to those
 * pages at upload time — the stored source is just the selection, and the rest
 * of the pipeline is unchanged.
 */

import { PDFDocument } from "pdf-lib";

/**
 * Parse a page-range string like "1-40, 55-60, 7" into 1-based inclusive ranges.
 * Returns null for empty input (meaning: whole document). Throws on malformed
 * input so the caller can reject it with a clear message.
 */
export function parsePageRanges(input: string): Array<[number, number]> | null {
  const s = (input || "").trim();
  if (!s) return null;

  const ranges: Array<[number, number]> = [];
  for (const raw of s.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) {
      throw new Error(`Invalid page range "${part}". Use formats like 1-40, 55-60, 7.`);
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end < start) {
      throw new Error(`Invalid page range "${part}". The start must be ≥ 1 and ≤ the end.`);
    }
    ranges.push([start, end]);
  }
  return ranges.length ? ranges : null;
}

export interface SubsetResult {
  buffer: Buffer;
  /** Number of pages kept, or -1 when the whole document is used. */
  selectedCount: number;
  totalPages: number;
}

/**
 * Subset a PDF to the given page ranges. Pages are kept in the order requested,
 * de-duplicated. If `input` is empty the original buffer is returned untouched
 * (whole document). Throws if a range falls entirely beyond the document.
 */
export async function subsetPdfByRanges(buffer: Buffer, input: string): Promise<SubsetResult> {
  const ranges = parsePageRanges(input);

  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = src.getPageCount();

  if (!ranges) return { buffer, selectedCount: -1, totalPages };

  const indices: number[] = [];
  const seen = new Set<number>();
  for (const [start, end] of ranges) {
    if (start > totalPages) {
      throw new Error(`Pages ${start}-${end} are beyond the document, which has ${totalPages} page(s).`);
    }
    for (let p = start; p <= Math.min(end, totalPages); p++) {
      const i = p - 1; // 0-based
      if (!seen.has(i)) {
        seen.add(i);
        indices.push(i);
      }
    }
  }
  if (indices.length === 0) {
    throw new Error(`No pages selected within the document's ${totalPages} page(s).`);
  }

  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  copied.forEach((p) => out.addPage(p));
  return { buffer: Buffer.from(await out.save()), selectedCount: indices.length, totalPages };
}
