/**
 * Renders an OCR result (typed block model) to a self-contained HTML document
 * for headless-Chromium → PDF printing (see ./pdf.ts).
 *
 * House style mirrors the translation .docx: serif (Noto Serif + matching Indic
 * Noto fonts for the source script), 14pt, double line-spacing, 2.5cm margins.
 * Flagged (uncertain/illegible) spans get a visible NEEDS HUMAN REVIEW marker so
 * nothing unreadable is silently presented as confident text.
 */

import { type Block, type Run, runsToText } from "../translate/model";
import type { OcrResult } from "./ocr";
import { type FontSpec, fontsForText, fontFamilyStack } from "./fonts";

const FLAG_COLOR = "#B00020";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRuns(runs: Run[]): string {
  const parts: string[] = [];
  for (const r of runs) {
    if (r.text) {
      const classes = [r.italic ? "i" : "", r.bold ? "b" : ""].filter(Boolean).join(" ");
      parts.push(classes ? `<span class="${classes}">${escapeHtml(r.text)}</span>` : escapeHtml(r.text));
    }
    if (r.flagged) {
      const marker = r.text
        ? `&nbsp;&nbsp;[⚠ NEEDS HUMAN REVIEW${r.note ? `: ${escapeHtml(r.note)}` : ""}]`
        : `[⚠ UNREADABLE — NEEDS HUMAN REVIEW${r.note ? `: ${escapeHtml(r.note)}` : ""}]`;
      parts.push(`<span class="flag">${marker}</span>`);
    }
  }
  return parts.join("") || "&nbsp;";
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case "heading":
      return `<h${block.level} class="h${block.level}">${renderRuns(block.runs)}</h${block.level}>`;
    case "paragraph": {
      const num = block.number ? `<span class="num">${escapeHtml(block.number)} </span>` : "";
      return `<p>${num}${renderRuns(block.runs)}</p>`;
    }
    case "partyLabel":
      return `<p class="party">${renderRuns(block.runs)}</p>`;
    case "signature":
      return `<p class="sig">${renderRuns(block.runs)}</p>`;
    case "kv":
      return `<table class="kv">${block.rows
        .map(
          (row) =>
            `<tr><td class="kvk">${escapeHtml(row.key)}</td><td>${renderRuns(row.value)}</td></tr>`
        )
        .join("")}</table>`;
    case "table": {
      const head = block.header.length
        ? `<thead><tr>${block.header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`
        : "";
      const body = block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderRuns(cell)}</td>`).join("")}</tr>`)
        .join("");
      if (!head && !body) return "";
      return `<table class="grid">${head}<tbody>${body}</tbody></table>`;
    }
  }
}

/** All text in the result, used to decide which script fonts to load. */
function allText(result: OcrResult): string {
  const out: string[] = [];
  for (const block of result.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "partyLabel":
      case "signature":
        out.push(runsToText(block.runs));
        break;
      case "kv":
        block.rows.forEach((r) => out.push(r.key, runsToText(r.value)));
        break;
      case "table":
        out.push(block.header.join(" "));
        block.rows.forEach((row) => row.forEach((cell) => out.push(runsToText(cell))));
        break;
    }
  }
  return out.join(" ");
}

export interface RenderedHtml {
  html: string;
  /** Fonts to register in Chromium before printing (in CSS fallback order). */
  fonts: FontSpec[];
}

export function renderOcrHtml(result: OcrResult): RenderedHtml {
  const fonts = fontsForText(allText(result));
  const fontStack = fontFamilyStack(fonts);
  const body = result.blocks.map(renderBlock).join("\n");

  // @font-face per needed script. Chromium fetches a font only when a glyph
  // actually uses it, so listing the matched set is cheap; ./pdf.ts waits for
  // document.fonts.ready before printing so none render as tofu.
  const fontFaces = fonts
    .map(
      (f) =>
        `  @font-face { font-family: '${f.cssName}'; src: url('${f.url}') format('truetype'); font-display: swap; }`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="und">
<head>
<meta charset="utf-8">
<style>
${fontFaces}
  @page { size: A4; margin: 2.5cm; }
  * { box-sizing: border-box; }
  body { font-family: ${fontStack}; font-size: 14pt; line-height: 2.0; color: #111; margin: 0; }
  p { margin: 0 0 8pt 0; }
  .num { color: #444; }
  .i { font-style: italic; }
  .b { font-weight: 700; }
  h1, h2, h3 { margin: 12pt 0 6pt 0; font-weight: 700; }
  .h1 { font-size: 18pt; text-align: center; }
  .h2 { font-size: 16pt; }
  .h3 { font-size: 15pt; }
  .party { text-align: right; font-weight: 600; margin-bottom: 4pt; }
  .sig { text-align: right; margin-top: 12pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; }
  table.kv td { border: none; padding: 1pt 6pt 1pt 0; vertical-align: top; }
  table.kv .kvk { font-weight: 700; width: 35%; }
  table.grid th, table.grid td { border: 1px solid #999; padding: 3pt 5pt; vertical-align: top; text-align: left; }
  table.grid th { background: #f2efe9; font-weight: 700; }
  .flag { color: ${FLAG_COLOR}; font-weight: 700; }
</style>
</head>
<body>
${body}
</body>
</html>`;

  return { html, fonts };
}
