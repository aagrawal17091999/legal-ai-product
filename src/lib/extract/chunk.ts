/**
 * Chunking for user-uploaded documents (Feature 1 ingestion).
 *
 * Ports the corpus pipeline's strategy (pipeline/chunk_utils.py): fixed-size
 * character windows with overlap. Defaults — 2000 chars (~500 tokens) with 200
 * char overlap — are tuned for legal text, where cross-references and context
 * span paragraph boundaries, so a generous overlap keeps a clause and the
 * sentence that qualifies it in the same window often enough to retrieve.
 *
 * Chunks carry the page number they start on (when known) so answers can cite
 * "Document — p.N". Page tracking is best-effort: OCR'd documents have no
 * reliable page map and report page_no = null.
 */

export const CHUNK_SIZE = 2000;
export const CHUNK_OVERLAP = 200;

export interface SourcePage {
  /** 1-based page number, or null when page boundaries are unknown (OCR). */
  page: number | null;
  text: string;
}

export interface DocChunk {
  chunkIndex: number;
  pageNo: number | null;
  text: string;
  /**
   * Half-open [startOffset, endOffset) of this chunk within the flattened
   * document text (the string returned by flattenPages). Lets the source panel
   * re-expand a chunk back out to whole sentences at display time.
   */
  startOffset: number;
  endOffset: number;
}

export interface FlatDocument {
  /** The full document text, pages joined with "\n\n". Offsets index into this. */
  text: string;
  /** Map a character offset back to the page number it falls on. */
  pageForOffset: (offset: number) => number | null;
}

/**
 * Concatenate per-page text into one string, remembering where each page starts
 * so a chunk's start offset maps back to a page number. Returned `text` is the
 * coordinate space every chunk offset (and expandToSentences) indexes into.
 */
export function flattenPages(pages: SourcePage[]): FlatDocument {
  let full = "";
  const pageStarts: Array<{ offset: number; page: number | null }> = [];
  for (const p of pages) {
    const t = (p.text || "").trim();
    if (!t) continue;
    pageStarts.push({ offset: full.length ? full.length + 2 : 0, page: p.page });
    full += (full ? "\n\n" : "") + t;
  }

  const text = full.trim();
  const pageForOffset = (offset: number): number | null => {
    let page: number | null = null;
    for (const ps of pageStarts) {
      if (ps.offset <= offset) page = ps.page;
      else break;
    }
    return page;
  };

  return { text, pageForOffset };
}

/**
 * Build overlapping chunks from already-flattened document text. Each chunk
 * carries its [startOffset, endOffset) in `text` so the source panel can expand
 * it back to whole sentences. A document with a single OCR page (page=null)
 * yields chunks with pageNo=null.
 */
export function chunkText(
  flat: FlatDocument,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): DocChunk[] {
  const { text, pageForOffset } = flat;
  if (!text) return [];

  const chunks: DocChunk[] = [];
  let start = 0;
  let chunkIndex = 0;
  while (start < text.length) {
    const hardEnd = Math.min(start + chunkSize, text.length);
    const end = hardEnd >= text.length ? hardEnd : findBoundary(text, start, hardEnd);
    const body = text.slice(start, end).trim();
    if (body) {
      chunks.push({
        chunkIndex: chunkIndex++,
        pageNo: pageForOffset(start),
        text: body,
        startOffset: start,
        endOffset: end,
      });
    }
    if (end >= text.length) break;
    // Step forward, keeping `overlap` chars of tail context, but always make
    // progress so a boundary near `start` can't stall the loop.
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/**
 * Convenience wrapper: flatten pages and chunk in one call. Equivalent to
 * chunkText(flattenPages(pages)).
 */
export function chunkPages(
  pages: SourcePage[],
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): DocChunk[] {
  return chunkText(flattenPages(pages), chunkSize, overlap);
}

// Pull a chunk's end back from the hard character limit to the nearest natural
// boundary — paragraph break first, then sentence end — so chunks don't slice
// through words/sentences (which both hurts embeddings and shows broken quotes
// in the source panel). We only search the last 40% of the window so a boundary
// is found without shrinking chunks too aggressively; if none exists we fall
// back to the hard limit.
function findBoundary(text: string, start: number, hardEnd: number): number {
  const minEnd = start + Math.floor((hardEnd - start) * 0.6);

  const para = text.lastIndexOf("\n\n", hardEnd);
  if (para >= minEnd) return para + 2;

  // Nearest sentence terminator (. ! ? optionally followed by a quote/paren)
  // followed by whitespace, scanning backward from the hard limit.
  for (let i = hardEnd; i > minEnd; i--) {
    const c = text[i - 1];
    if ((c === "." || c === "!" || c === "?") && /\s/.test(text[i] ?? " ")) {
      return i;
    }
  }

  const space = text.lastIndexOf(" ", hardEnd);
  if (space >= minEnd) return space + 1;

  return hardEnd;
}

/**
 * Expand a chunk's [start, end) range outward to the sentence (or paragraph)
 * boundaries that enclose it, against the full document `text`. The retrieval
 * chunker slices on fixed character windows with overlap, so a chunk's start
 * almost always lands mid-sentence; this re-grows it to whole sentences for the
 * source panel. Expansion is capped at `pad` chars per side so a passage with no
 * nearby boundary can't pull in the entire document.
 */
export function expandToSentences(
  text: string,
  start: number,
  end: number,
  pad = 800
): string {
  const lo = sentenceStart(text, start, Math.max(0, start - pad));
  const hi = sentenceEnd(text, end, Math.min(text.length, end + pad));
  return text.slice(lo, hi).trim();
}

// First char of the sentence containing `pos`: scan left for the previous
// sentence terminator or a paragraph break, then skip the whitespace after it.
// Clamps to `floor` when no boundary is within reach.
function sentenceStart(text: string, pos: number, floor: number): number {
  for (let i = pos; i > floor; i--) {
    if (text[i - 1] === "\n" && text[i] === "\n") return i + 1;
    const c = text[i - 1];
    if ((c === "." || c === "!" || c === "?") && /\s/.test(text[i] ?? " ")) {
      let j = i;
      while (j < pos && /\s/.test(text[j] ?? "")) j++;
      return j;
    }
  }
  return floor;
}

// Index just past the end of the sentence containing the chunk's last char:
// scan right from `pos - 1` for the next terminator (or paragraph break),
// including a trailing closing quote/paren. Clamps to `ceil`.
function sentenceEnd(text: string, pos: number, ceil: number): number {
  for (let i = Math.max(pos - 1, 0); i < ceil; i++) {
    if (text[i] === "\n" && text[i + 1] === "\n") return i;
    const c = text[i];
    if ((c === "." || c === "!" || c === "?") && /\s|^$/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      if (/["')\]]/.test(text[j] ?? "")) j++;
      return j;
    }
  }
  return ceil;
}
