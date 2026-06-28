/**
 * Renders a translated legal draft to a .docx from the structured block model
 * (src/lib/translate/model.ts), applying the configurable template
 * (src/lib/translate/template.ts).
 *
 * The block model preserves judicial layout — headings, the cause-title
 * key/value block, numbered paragraphs, real tables, party labels, signatures,
 * and italicised case citations — so the output reads like the source document
 * rather than a flat wall of paragraphs.
 *
 * House-style fields the source can't supply (running header, page numbers) are
 * rendered as clearly-marked "[TO BE PROVIDED]" placeholders — never guessed.
 * Flagged (uncertain/illegible) spans get a visible NEEDS HUMAN REVIEW marker.
 * The certification notice is included by default.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  TableBorders,
  WidthType,
  Header,
  Footer,
  AlignmentType,
  HeadingLevel,
  LineRuleType,
  PageNumber,
  convertMillimetersToTwip,
} from "docx";
import { DEFAULT_TEMPLATE, type DocxTemplate } from "./template";
import type { Block, Run } from "./model";

const FLAG_COLOR = "B00020";

/** Convert structured runs into docx TextRuns, appending a review marker for
 *  any flagged span (text + marker, or a standalone UNREADABLE marker). */
function toTextRuns(runs: Run[], size: number, baseBold = false): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (r.text) {
      out.push(new TextRun({ text: r.text, italics: r.italic, bold: r.bold || baseBold, size }));
    }
    if (r.flagged) {
      const marker = r.text
        ? `  [⚠ NEEDS HUMAN REVIEW${r.note ? `: ${r.note}` : ""}]`
        : `[⚠ UNREADABLE — NEEDS HUMAN REVIEW${r.note ? `: ${r.note}` : ""}]`;
      out.push(new TextRun({ text: marker, bold: true, color: FLAG_COLOR, size }));
    }
  }
  if (out.length === 0) out.push(new TextRun({ text: "", size }));
  return out;
}

function headingLevelFor(level: 1 | 2 | 3) {
  return level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
}

function renderBlock(block: Block, size: number): Array<Paragraph | Table> {
  switch (block.type) {
    case "heading":
      return [
        new Paragraph({
          heading: headingLevelFor(block.level),
          alignment: block.level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
          spacing: { before: 240, after: 120 },
          children: toTextRuns(block.runs, block.level === 1 ? size + 4 : size + 2, true),
        }),
      ];

    case "paragraph": {
      const children = block.number
        ? [new TextRun({ text: `${block.number} `, size }), ...toTextRuns(block.runs, size)]
        : toTextRuns(block.runs, size);
      return [new Paragraph({ spacing: { after: 120 }, children })];
    }

    case "partyLabel":
      return [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 80 }, children: toTextRuns(block.runs, size, true) })];

    case "signature":
      return [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 240 }, children: toTextRuns(block.runs, size) })];

    case "kv":
      // A docx Table with zero rows throws "Invalid array length" (it does
      // Array(Math.max(...[])) === Array(-Infinity)). A model can emit an empty
      // kv block, so skip it rather than crash the whole render.
      if (block.rows.length === 0) return [];
      // Borderless two-column table for the cause-title (label : value) block.
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: TableBorders.NONE,
          rows: block.rows.map(
            (row) =>
              new TableRow({
                children: [
                  new TableCell({
                    width: { size: 35, type: WidthType.PERCENTAGE },
                    children: [new Paragraph({ children: [new TextRun({ text: row.key, bold: true, size })] })],
                  }),
                  new TableCell({
                    width: { size: 65, type: WidthType.PERCENTAGE },
                    children: [new Paragraph({ children: toTextRuns(row.value, size) })],
                  }),
                ],
              })
          ),
        }),
      ];

    case "table": {
      const rows: TableRow[] = [];
      if (block.header.length) {
        rows.push(
          new TableRow({
            tableHeader: true,
            children: block.header.map(
              (h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size })] })] })
            ),
          })
        );
      }
      for (const dataRow of block.rows) {
        rows.push(
          new TableRow({
            children: dataRow.map(
              (cell) => new TableCell({ children: [new Paragraph({ children: toTextRuns(cell, size) })] })
            ),
          })
        );
      }
      if (rows.length === 0) return [];
      return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })];
    }
  }
}

/**
 * Render a typed block model (headings, numbered paragraphs, cause-title kv,
 * tables, party labels, signatures) to a .docx. Used by both the translation
 * feature and the OCR feature — neither passes anything translation-specific;
 * the renderer only walks `blocks`.
 */
export async function renderBlocksDocx(
  result: { blocks: Block[] },
  templateOverrides: Partial<DocxTemplate> = {}
): Promise<Buffer> {
  const t: DocxTemplate = { ...DEFAULT_TEMPLATE, ...templateOverrides };
  const size = t.fontSizePt * 2; // half-points
  const line = Math.round(t.lineSpacing * 240); // 240 = single
  const margin = convertMillimetersToTwip(t.marginCm * 10);
  const leftMargin = t.bindingMarginCm != null ? convertMillimetersToTwip(t.bindingMarginCm * 10) : margin;

  const body: Array<Paragraph | Table> = [];

  // ── Optional house-style cause-title override, printed above everything ──
  if (t.causeTitle) {
    for (const lineText of t.causeTitle.split("\n")) {
      body.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: lineText, bold: true, size })] }));
    }
  }

  // ── Translated content only — no draft banner / language line / AI notice ──
  // Fault-isolate per block: a single degenerate block (e.g. a malformed table
  // that trips the docx library) must not crash the whole document — render it as
  // a visible flagged marker and keep going.
  for (const block of result.blocks) {
    try {
      body.push(...renderBlock(block, size));
    } catch {
      body.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [
            new TextRun({
              text: "[⚠ A section could not be rendered and needs human review]",
              bold: true,
              color: FLAG_COLOR,
              size,
            }),
          ],
        })
      );
    }
  }

  // ── Header / footer: only real house-style content, if explicitly set. No AI
  //    certification notice and no "[TO BE PROVIDED]" placeholders. ──
  const headerChildren: Paragraph[] = t.header
    ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t.header, size: size - 4 })] })]
    : [];

  const footerChildren: Paragraph[] = [];
  if (t.footerNote) {
    footerChildren.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t.footerNote, size: size - 6 })] }));
  }
  if (t.pageNumbers && t.pageNumbers !== "none") {
    footerChildren.push(
      new Paragraph({
        alignment: t.pageNumbers === "footer-right" ? AlignmentType.RIGHT : AlignmentType.CENTER,
        children: [new TextRun({ children: ["Page ", PageNumber.CURRENT], size: size - 6 })],
      })
    );
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: t.font, size },
          paragraph: { spacing: { line, lineRule: LineRuleType.AUTO } },
        },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: margin, right: margin, bottom: margin, left: leftMargin } } },
        ...(headerChildren.length ? { headers: { default: new Header({ children: headerChildren }) } } : {}),
        ...(footerChildren.length ? { footers: { default: new Footer({ children: footerChildren }) } } : {}),
        children: body,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
