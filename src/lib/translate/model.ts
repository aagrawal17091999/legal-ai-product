/**
 * Structured document model for the translation feature (Feature 2).
 *
 * This is the intermediate representation that replaces the old flat
 * extract→text→translate chain. A single vision pass over the source emits a
 * list of TYPED BLOCKS that already carry the translated text plus structure
 * (headings, numbered paragraphs, key/value cause-title blocks, tables, party
 * labels, signatures) — so the .docx renderer can reproduce judicial layout
 * instead of a wall of paragraphs.
 *
 * Each run also carries `flagged`: when the model cannot confidently read part
 * of the source, it flags that run rather than guessing — for legal work an
 * honestly-marked gap is far safer than a confident wrong translation.
 */

/** A styled span of translated text within a block. */
export interface Run {
  text: string;
  italic?: boolean;
  bold?: boolean;
  /** True when the model could not confidently read/translate this span. */
  flagged?: boolean;
  /** Why it was flagged (illegible, ambiguous script, etc.), or null. */
  note?: string | null;
}

/** A structural element of the document, in reading order. */
export type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; number?: string | null; runs: Run[] }
  | { type: "kv"; rows: Array<{ key: string; value: Run[] }> }
  | { type: "table"; header: string[]; rows: Run[][][] }
  | { type: "partyLabel"; runs: Run[] }
  | { type: "signature"; runs: Run[] };

export type BlockType = Block["type"];

/** Flat segment shape kept for the existing in-app viewer + segment counts. */
export interface TranslatedSegment {
  source: string;
  translation: string;
  flagged: boolean;
  note: string | null;
}

/**
 * The stored translation result. `blocks` drives the .docx renderer; `segments`
 * is a flattened projection kept so the existing viewer and the
 * segment_count/flagged_count columns keep working unchanged.
 */
export interface TranslationResult {
  detectedLanguage: string;
  targetLanguage: string;
  blocks: Block[];
  segments: TranslatedSegment[];
  flaggedCount: number;
  /** True when a vision pass read the source pixels/PDF (vs. a DOCX text path). */
  ocrUsed: boolean;
}

/** Join a run list into plain text. */
export function runsToText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

function runsFlagged(runs: Run[]): { flagged: boolean; note: string | null } {
  const first = runs.find((r) => r.flagged);
  return { flagged: Boolean(first), note: first?.note ?? null };
}

/**
 * Project the structured blocks into the flat segment list the viewer renders.
 * Tables/kv blocks become one segment per row so nothing is dropped from the
 * preview; the real structure is reproduced in the .docx.
 */
export function flattenToSegments(blocks: Block[]): TranslatedSegment[] {
  const segments: TranslatedSegment[] = [];
  const push = (text: string, runs: Run[]) => {
    const { flagged, note } = runsFlagged(runs);
    segments.push({ source: "", translation: text, flagged, note });
  };

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "partyLabel":
      case "signature":
        push(runsToText(block.runs), block.runs);
        break;
      case "paragraph": {
        const text = block.number ? `${block.number} ${runsToText(block.runs)}` : runsToText(block.runs);
        push(text, block.runs);
        break;
      }
      case "kv":
        for (const row of block.rows) push(`${row.key}: ${runsToText(row.value)}`, row.value);
        break;
      case "table": {
        if (block.header.length) {
          segments.push({ source: "", translation: block.header.join(" | "), flagged: false, note: null });
        }
        for (const row of block.rows) {
          const runs = row.flat();
          push(row.map(runsToText).join(" | "), runs);
        }
        break;
      }
    }
  }
  return segments;
}

/** Count distinct flagged spans across all blocks. */
export function countFlagged(blocks: Block[]): number {
  let n = 0;
  const tally = (runs: Run[]) => runs.forEach((r) => r.flagged && n++);
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "partyLabel":
      case "signature":
        tally(block.runs);
        break;
      case "kv":
        block.rows.forEach((r) => tally(r.value));
        break;
      case "table":
        block.rows.forEach((row) => row.forEach(tally));
        break;
    }
  }
  return n;
}
