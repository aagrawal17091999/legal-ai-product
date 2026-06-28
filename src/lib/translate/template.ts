/**
 * Configurable .docx formatting template for translated legal drafts (Feature 2).
 *
 * The confirmed house style is filled in. The court-filing specifics Ansh has
 * NOT yet provided are left as explicit `null` placeholders — the renderer emits
 * a clearly-marked "[TO BE PROVIDED]" block for each so nothing is silently
 * guessed, and they can be filled in here later WITHOUT touching the renderer.
 *
 * Decisions locked with Ansh:
 *   - Margins: 2.5 cm (all sides, unless a binding margin is set below)
 *   - Font: Times New Roman, 14pt
 *   - Line spacing: 2.0 (double)
 *   - Certification notice: KEPT (AI translation is a draft, not file-ready)
 */

export interface DocxTemplate {
  font: string;
  fontSizePt: number;
  lineSpacing: number; // 1.0 single, 2.0 double
  marginCm: number; // uniform margin for all sides
  /** Optional wider left margin for binding. null = same as marginCm. (TODO) */
  bindingMarginCm: number | null;

  // ── Court-filing specifics — TODO, Ansh to provide. null → placeholder block ─
  /** Court name / parties / case-number layout printed at the top. */
  causeTitle: string | null;
  /** Running header text. */
  header: string | null;
  /** Extra footer text (beyond the certification notice). */
  footerNote: string | null;
  /** Clause / paragraph numbering style description. */
  numberingStyle: string | null;
  /** Page-number placement. null → placeholder note, "none" → omit silently. */
  pageNumbers: "none" | "footer-center" | "footer-right" | null;

  /** Keep the human-certification-required notice (default true). */
  certificationNotice: boolean;
}

export const DEFAULT_TEMPLATE: DocxTemplate = {
  font: "Times New Roman",
  fontSizePt: 14,
  lineSpacing: 2.0,
  marginCm: 2.5,
  bindingMarginCm: null,

  causeTitle: null,
  header: null,
  footerNote: null,
  numberingStyle: null,
  pageNumbers: null,

  certificationNotice: true,
};

export const CERTIFICATION_TEXT =
  "DRAFT — AI-GENERATED TRANSLATION. This document was produced by automated " +
  "translation and is provided for review only. It is NOT a certified translation. " +
  "It must be reviewed and certified by a qualified human translator before being " +
  "filed or relied upon in any legal proceeding.";
