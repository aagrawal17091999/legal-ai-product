import type { AssembledCase } from "./contextBuilder";

/**
 * Post-generation citation validator.
 *
 * Scans the assistant's output for `[^n]` and `[^n, ¶p]` citation markers
 * (the two shapes the system prompt tells Claude to use) and checks every
 * one against the set of cases actually assembled into context this turn.
 *
 * The validator only flags structural mismatches:
 *   - Unknown case index: the marker references a case that was never in
 *     SEARCH RESULTS.
 *   - Unknown paragraph: the marker pinpoints a paragraph that isn't visible
 *     in the excerpt we sent the model.
 *
 * Bad citations don't invalidate the whole response — the validator appends
 * a transparent `> Citation warning:` footer so the user knows what failed,
 * and records a structured warning for the audit log. The answer text
 * itself is returned unchanged.
 */

export interface CitationMismatch {
  /** Raw marker the model wrote. */
  marker: string;
  case_index: number;
  paragraph: string | null;
  reason: "unknown_case" | "unknown_paragraph";
}

export interface ValidationResult {
  /** Possibly-augmented text (warning footer appended when mismatches exist). */
  text: string;
  mismatches: CitationMismatch[];
  /** Every citation the model produced, whether valid or not. Useful telemetry. */
  allMarkers: Array<{ marker: string; case_index: number; paragraph: string | null }>;
}

// `[^12]`, `[^12, ¶42]`, `[^12,¶42]`, `[^12, ¶42a]`. Tolerate the space.
const MARKER_RE = /\[\^(\d+)(?:\s*,\s*¶([0-9]+(?:\.[0-9]+)?[A-Za-z]?))?\]/g;

export function validateCitations(
  text: string,
  cases: AssembledCase[]
): ValidationResult {
  const byIndex = new Map<number, AssembledCase>();
  for (const c of cases) byIndex.set(c.index, c);

  const mismatches: CitationMismatch[] = [];
  const allMarkers: ValidationResult["allMarkers"] = [];
  const seenMarkers = new Set<string>();

  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const marker = m[0];
    const caseIndex = parseInt(m[1], 10);
    const paragraph = m[2] ?? null;

    if (!seenMarkers.has(marker)) {
      seenMarkers.add(marker);
      allMarkers.push({ marker, case_index: caseIndex, paragraph });
    }

    const assembled = byIndex.get(caseIndex);
    if (!assembled) {
      mismatches.push({ marker, case_index: caseIndex, paragraph, reason: "unknown_case" });
      continue;
    }

    if (paragraph !== null) {
      const visible = assembled.chunk_paragraphs ?? [];
      // The model may cite either "42" or "42a" when the excerpt split a long
      // paragraph. Accept both the literal and the underlying parent number.
      const parent = paragraph.replace(/[A-Za-z]$/, "");
      const ok = visible.includes(paragraph) || (parent && visible.includes(parent));
      if (!ok) {
        mismatches.push({
          marker,
          case_index: caseIndex,
          paragraph,
          reason: "unknown_paragraph",
        });
      }
    }
  }

  if (mismatches.length === 0) {
    return { text, mismatches, allMarkers };
  }

  // Summarize mismatches into one footer line per unique marker so repeated
  // bad citations collapse.
  const byMarker = new Map<string, CitationMismatch>();
  for (const mm of mismatches) {
    if (!byMarker.has(mm.marker)) byMarker.set(mm.marker, mm);
  }
  const lines = Array.from(byMarker.values()).map((mm) => {
    if (mm.reason === "unknown_case") {
      return `- ${mm.marker} refers to a case not in this turn's retrieved set.`;
    }
    return `- ${mm.marker} pinpoints a paragraph not visible in the retrieved excerpt for that case.`;
  });
  const footer = `\n\n> **Citation warning:** one or more citation markers could not be resolved against the retrieved cases. These citations may be incorrect:\n${lines.join("\n")}`;

  return { text: text + footer, mismatches, allMarkers };
}
