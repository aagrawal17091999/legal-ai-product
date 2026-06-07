/**
 * Deterministic citation normalizer.
 *
 * The system prompt tells the model to cite with the caret form `[^n]` /
 * `[^n, ¶p]`, but models frequently drop the caret and write `[n]` / `[n, ¶p]`
 * (the bare-bracket habit reinforced by numbered reference lists). A bare marker
 * is invisible to THREE downstream systems, all of which match `\[\^…\]`:
 *   - the renderer (MessageBubble) — bare markers never become clickable links,
 *   - the citation validator — can't check a marker it can't see,
 *   - the faithfulness judge — extracts zero claims, so the groundedness check
 *     silently no-ops.
 *
 * This pass repairs the common malformations into the canonical caret form
 * BEFORE those systems run, so prompt imperfection doesn't disable grounding.
 *
 * Conservatism rules (to avoid rewriting legitimate numeric brackets in legal
 * prose like statutory clause "[1]"):
 *   - A marker that already has the caret (`[^3]`) is never touched — the regex
 *     can't match it (the char after `[` is `^`, not a digit).
 *   - `[n, ¶p]` (carries a ¶ pinpoint) is ALWAYS upgraded: the ¶ makes it
 *     unambiguously a citation attempt. An out-of-range index is left for the
 *     validator to flag rather than silently hidden as plain text.
 *   - Bare `[n]` (no ¶) is upgraded ONLY when `n` is within the range of cases
 *     actually assembled this turn (1..maxIndex). Out-of-range bare brackets are
 *     left untouched — they're almost certainly not citations.
 */

// Matches `[12]` and `[12, ¶42]` / `[12,¶42a]` but NOT `[^12]` (the char after
// `[` would be `^`, which `\d` rejects). The paragraph group, if present,
// includes its leading comma/space so it can be spliced back verbatim.
const BARE_MARKER_RE =
  /\[(\d+)(\s*,\s*¶[0-9]+(?:\.[0-9]+)?[A-Za-z]?)?\]/g;

export interface NormalizeResult {
  text: string;
  /** How many bare markers were upgraded to the caret form. */
  upgraded: number;
}

/**
 * Upgrade bare `[n]` / `[n, ¶p]` citation markers to `[^n]` / `[^n, ¶p]`.
 *
 * @param text     the model's answer
 * @param maxIndex highest valid case index this turn (assembledCases.length);
 *                 bare markers with n > maxIndex are left as plain text.
 */
export function normalizeCitations(text: string, maxIndex: number): NormalizeResult {
  let upgraded = 0;
  const out = text.replace(BARE_MARKER_RE, (full, n: string, para?: string) => {
    const idx = parseInt(n, 10);
    if (para) {
      // Has a ¶ pinpoint → unambiguously a citation. Always upgrade; let the
      // validator surface an out-of-range index rather than hiding it.
      upgraded++;
      return `[^${n}${para}]`;
    }
    if (idx >= 1 && idx <= maxIndex) {
      upgraded++;
      return `[^${n}]`;
    }
    // Out-of-range bare bracket — probably not a citation. Leave untouched.
    return full;
  });
  return { text: out, upgraded };
}
