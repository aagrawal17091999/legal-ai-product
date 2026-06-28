/**
 * Boilerplate cleanup for extracted document text (Feature 1 ingestion quality).
 *
 * Legal PDFs interleave per-page signature stamps, court footers, and — for
 * reported judgments — law-publisher watermarks (SCC Online / EBC TruePrint)
 * directly into the text layer. Two real examples we have to defeat:
 *
 *   "…four days in two spells Digitally Signed By:AJIT KUMAR Signing
 *    Date:25.04.2026 17:31:55 Signature Not Verified W.P.(C) 17582/2025
 *    Page 15 of 44 in 2017-2018, 48 days…"
 *
 *   "SCC Online Web Edition, © 2026 EBC Publishing Pvt. Ltd. … Printed For:
 *    Anurag Ahluwalia … this judgment is protected by the law declared by the
 *    Supreme Court in Eastern Book Company v. D.B. Modak, (2008) 1 SCC 1 …"
 *
 * Left in place this noise (a) pollutes the embedding of every chunk so
 * retrieval surfaces — and the model cites — the watermark instead of the law,
 * (b) splits real sentences so the model reads broken clauses, and (c) is shown
 * to the user as the "verified source". We strip it in three passes: drop known
 * junk lines, drop lines that recur across many pages (running headers/footers),
 * then strip inline stamp/footer patterns. Conservative by design — when in
 * doubt we keep text, because dropping real content is worse than a little noise.
 */

import type { SourcePage } from "./chunk";

// ── Whole-line junk: headers/footers/watermarks that sit on their own line ──
// Each is matched against a trimmed line; a hit drops the line entirely.
const JUNK_LINE_RES: RegExp[] = [
  /^\s*\d{1,4}\s*$/, // a bare page-number line
  /SCC\s*Online\s*Web\s*Edition/i,
  /EBC\s*Publishing/i,
  /scconline\.com/i,
  /Printed\s*For\s*:/i,
  /True\s*Print/i, // "TruePrint" / "True Print" masthead
  /TRUE\s*COPY/i,
  /protected by the law declared by the Supreme Court in Eastern Book Company/i,
  /Eastern Book Company v\.?\s*D\.?B\.?\s*Modak/i,
  /Modak,?\s*\(?\d{4}\)?\s*\d+\s*SCC\s*1\s*paras/i,
  /^\s*Signature\s+(?:Not\s+Verified|invalid)\s*$/i,
  /Digitally\s+Signed/i,
  /^\s*Signed\s+By\b/i,
  /Signing\s*Date\s*:/i,
  /^\s*Page\s+\d+\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i, // "Page 1 Monday, April 13, 2026"
  /^-{20,}$/, // long divider rules used around watermarks
];

// ── OCR-garbage detection ──────────────────────────────────────────────────
// Scanned legal PDFs carry a sideways digital-signature certificate stamp in
// the page margin. OCR can't read the rotated, stylized glyphs, so it emits
// gibberish like:
//   "■^ikodkr.tiwarKO> I / Delhi Hish Court \ ^leSn.Ne. 214^6/2020 I ★ C
//    Expiry Date 1 \ 15/03/2030 >Q3"
// None of the clean-text stamp patterns above match this form, so it used to
// survive into chunks (and the citation panel). We catch it structurally: box/
// star glyphs and a high density of carets/backslashes/brackets never occur in
// real legal prose, only in OCR'd seals.
const STAMP_GLYPH_RE = /[■□▪▫★☆✦◆●◦※]/;
const WEIRD_SYM_RE = /[\^~`|<>\\{}]/g;

function isGarbledLine(line: string): boolean {
  if (line.length < 4) return false;
  if (STAMP_GLYPH_RE.test(line)) return true; // pure image-OCR artifact
  const weird = (line.match(WEIRD_SYM_RE) || []).length;
  // 3+ such symbols, or >12% of the line, is noise — not a sentence.
  return weird >= 3 || weird / line.length > 0.12;
}

function isJunkLine(line: string): boolean {
  return isGarbledLine(line) || JUNK_LINE_RES.some((re) => re.test(line));
}

// ── Inline patterns: noise embedded mid-sentence (no newline to anchor on) ──
const SIGNATURE_BLOCK_RE =
  /Digitally Signed By\s*:?[\s\S]{0,80}?Signing Date\s*:?[\s\S]{0,40}?(?:Signature Not Verified)?(?=\s|$)/gi;
const SIGNED_BY_RE = /Signed By[\s\S]{0,50}?Signing Date[\s\S]{0,40}?\d{2}:\d{2}:\d{2}/gi;
const SIGNATURE_TAG_RE = /\bSignature\s+(?:Not Verified|invalid)\b/gi;
const PAGE_FOOTER_RE = /\bPage\s+\d+\s+of\s+\d+\b/gi;
const CASE_FOOTER_RE = /\bW\.?P\.?\([A-Z]+\)\s*\d+\/\d{2,4}\s*(?=Page\s+\d+\s+of\s+\d+)/gi;
const SCC_INLINE_RE = /SCC\s*Online\s*Web\s*Edition[^\n]*/gi;
const TRUEPRINT_RE = /TruePrint[™\s]*source:[^\n]*/gi;
const MODAK_RE =
  /this judgment is protected by the law declared by the Supreme Court in Eastern Book Company[\s\S]{0,120}?paras?[\s\S]{0,20}?\d+\s*[.&]/gi;
const TRUECOPY_RE = /TRUE\s*COPY/gi;
// OCR'd certificate stamp embedded mid-sentence: starts at a box/star glyph and
// runs through the "Expiry Date <date>" that every cert seal carries. Gated on
// the glyph so a real contract's "expiry date" prose is never touched.
const CERT_STAMP_INLINE_RE =
  /[■□▪▫★☆✦◆●][\s\S]{0,180}?Expiry\s*Date[\s\S]{0,30}?\d{1,2}\/\d{1,2}\/\d{2,4}[^\n]{0,8}/gi;

function stripPatterns(text: string): string {
  let out = text;
  out = out.replace(CERT_STAMP_INLINE_RE, " ");
  out = out.replace(SIGNATURE_BLOCK_RE, " ");
  out = out.replace(SIGNED_BY_RE, " ");
  out = out.replace(MODAK_RE, " ");
  out = out.replace(SCC_INLINE_RE, " ");
  out = out.replace(TRUEPRINT_RE, " ");
  out = out.replace(CASE_FOOTER_RE, " ");
  out = out.replace(PAGE_FOOTER_RE, " ");
  out = out.replace(TRUECOPY_RE, " ");
  out = out.replace(SIGNATURE_TAG_RE, " ");
  // Collapse the whitespace the removals leave behind, but preserve paragraph
  // breaks (double newlines) so the boundary-aware chunker still has structure.
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/ ?\n ?/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/** Normalize a line for repeated-line comparison (ignore page numbers/spacing). */
function normalizeLine(line: string): string {
  return line
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Remove running headers/footers: short lines whose normalized form recurs
 * across pages. A line is treated as noise if it appears on >= 20% of pages OR
 * on >= 8 pages outright — the second rule catches publisher watermarks that
 * run through one section of a mixed bundle (e.g. the SCC pages) without
 * reaching a majority of the whole document. Real body sentences essentially
 * never recur verbatim that often. Only runs for multi-page text-layer docs.
 */
function stripRepeatedLines(pages: SourcePage[]): SourcePage[] {
  if (pages.length < 4) return pages;

  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const raw of (p.text || "").split("\n")) {
      const line = raw.trim();
      if (!line || line.length > 100) continue; // headers/footers are short
      const norm = normalizeLine(line);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
    }
  }

  const fractionFloor = Math.max(3, Math.ceil(pages.length * 0.2));
  const repeated = new Set(
    [...counts.entries()]
      .filter(([, n]) => n >= fractionFloor || n >= 8)
      .map(([k]) => k)
  );
  if (repeated.size === 0) return pages;

  return pages.map((p) => ({
    page: p.page,
    text: (p.text || "")
      .split("\n")
      .filter((raw) => {
        const line = raw.trim();
        if (!line || line.length > 100) return true;
        return !repeated.has(normalizeLine(line));
      })
      .join("\n"),
  }));
}

/** Drop known junk lines from a single page's text. */
function stripJunkLines(text: string): string {
  return (text || "")
    .split("\n")
    .filter((raw) => !isJunkLine(raw.trim()))
    .join("\n");
}

/** Clean a single block of extracted text (line + pattern passes). */
export function cleanText(text: string): string {
  return stripPatterns(stripJunkLines(text || ""));
}

/**
 * Clean per-page extracted text before chunking: drop running headers/footers
 * (cross-page), drop known junk lines, then strip inline stamp/footer patterns.
 * Empty pages are dropped so they don't create phantom page offsets.
 */
export function cleanPages(pages: SourcePage[]): SourcePage[] {
  return stripRepeatedLines(pages)
    .map((p) => ({ page: p.page, text: stripPatterns(stripJunkLines(p.text || "")) }))
    .filter((p) => p.text.trim().length > 0);
}
