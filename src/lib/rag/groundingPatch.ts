import { getAnthropicClient } from "../claude";
import { logError } from "../error-logger";
import type { FaithfulnessFinding } from "./faithfulness";
import type { AssembledCase } from "./contextBuilder";

/**
 * Surgical repair for the grounding gate.
 *
 * When the faithfulness judge flags a cited sentence, the loop used to send the
 * whole draft back with "output ONLY the complete corrected final answer" — so
 * the model rewrote every paragraph, including the (usually large) majority that
 * was already correct. On a measured production turn that meant ~7,990 output
 * tokens for a ~3,700-token answer: the answer was written twice, and the second
 * write sat between the user and their reply.
 *
 * This asks a much smaller question instead: here are N flagged sentences and
 * the excerpts they cite — return a corrected replacement for each. The rest of
 * the answer is untouched by construction, so nothing correct can be disturbed
 * by the repair.
 *
 * Safety properties that keep the gate's guarantee intact:
 *   - A replacement is spliced only on an exact, unique match of the original
 *     sentence. Anything ambiguous is left alone rather than guessed at.
 *   - Returning `null` means "could not repair" and the caller falls back to the
 *     original full-rewrite path — the gate never silently gives up.
 *   - Replacements are re-graded by the caller before the answer ships.
 */

const PATCH_MODEL = process.env.GROUNDING_PATCH_MODEL?.trim() || "claude-sonnet-4-6";
const MAX_EXCERPT_CHARS = 6000;
const MAX_PATCH_CLAIMS = 12;

const PATCH_SYSTEM_PROMPT = `You are correcting specific sentences in a legal research answer.

Each sentence below cites a case using a [^n] marker, but a grounding check found the cited case's excerpt does NOT support what the sentence asserts.

For EACH flagged sentence, return a corrected replacement that is fully supported by the excerpt of the case it cites. Your options, in order of preference:
  1. Narrow or correct the statement so the cited excerpt genuinely supports it.
  2. Re-cite a DIFFERENT case from the excerpts provided, if one actually supports the statement — change the [^n] marker accordingly.
  3. Delete the sentence entirely (return an empty replacement) if nothing provided supports it.

Rules:
  - Preserve the original sentence's role and register. This is formal legal writing: impersonal, precise, no hedging filler.
  - Keep [^n] citation markers in the same format, including any paragraph pinpoint (e.g. [^3, ¶42]).
  - NEVER assert something the excerpts do not support. An accurate narrower sentence is always better than a broad one.
  - Do not add commentary, preamble, or explanation of your changes.

Respond with ONLY a JSON array, no prose and no code fences:
[{"id": 1, "replacement": "<corrected sentence, or empty string to delete>"}]`;

export interface PatchResult {
  /** The draft with every successful replacement spliced in. */
  text: string;
  /** Replacement sentences that were actually applied, for re-grading. */
  replacements: string[];
  /** The original claims that were successfully replaced. */
  patchedClaims: string[];
  /** Flagged claims left untouched (no usable replacement / no unique match). */
  unpatchedClaims: string[];
}

/**
 * Attempt a targeted repair of `unsupported` claims inside `draft`.
 * Returns null when the repair could not be made at all — caller should then
 * fall back to a full rewrite.
 */
export async function patchUnsupported(params: {
  draft: string;
  unsupported: FaithfulnessFinding[];
  cases: AssembledCase[];
  abortSignal?: AbortSignal;
}): Promise<PatchResult | null> {
  const { draft, unsupported, cases, abortSignal } = params;
  if (unsupported.length === 0) return null;

  // Only sentences that appear exactly once in the draft are safely splice-able.
  // A sentence repeated verbatim gives us no way to know which occurrence the
  // judge meant, so it goes to the fallback path instead of being guessed at.
  const targets = unsupported
    .filter((f) => occurrences(draft, f.claim) === 1)
    .slice(0, MAX_PATCH_CLAIMS);
  if (targets.length === 0) return null;

  const byIndex = new Map<number, AssembledCase>();
  for (const c of cases) byIndex.set(c.index, c);

  // Give the model every case cited by a flagged claim. Re-citing (option 2) is
  // only honest if it can actually read the alternative it might cite.
  const relevantIndices = Array.from(new Set(targets.map((t) => t.case_index)));
  const excerptBlocks = relevantIndices.map((idx) => {
    const c = byIndex.get(idx);
    const title = c?.meta.title || "(untitled)";
    const body = (c?.excerpt || "").slice(0, MAX_EXCERPT_CHARS);
    return `--- Case [${idx}] — ${title} ---\n${body || "(no excerpt available)"}`;
  });

  const claimLines = targets.map(
    (t, i) =>
      `${i + 1}. [cites Case ${t.case_index}] "${t.claim}"\n   Problem: ${t.reason}`
  );

  const userContent =
    `CASE EXCERPTS (the only evidence available):\n\n${excerptBlocks.join("\n\n")}` +
    `\n\nFLAGGED SENTENCES TO CORRECT:\n${claimLines.join("\n")}`;

  let raw = "";
  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: PATCH_MODEL,
        max_tokens: Math.min(4096, 400 + targets.length * 250),
        system: PATCH_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      },
      { signal: abortSignal }
    );
    const textBlock = response.content.find((b) => b.type === "text");
    raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
  } catch (err) {
    logError({
      category: "chat",
      message: `grounding patch call failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { model: PATCH_MODEL, claims: targets.length },
    });
    return null;
  }

  const parsed = parseReplacements(raw);
  if (parsed.size === 0) return null;

  let text = draft;
  const replacements: string[] = [];
  const patchedClaims: string[] = [];
  const unpatchedClaims: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const claim = targets[i].claim;
    const replacement = parsed.get(i + 1);
    if (replacement === undefined) {
      unpatchedClaims.push(claim);
      continue;
    }
    // Re-check uniqueness against the CURRENT text: an earlier splice could in
    // principle have introduced a duplicate of a later target.
    if (occurrences(text, claim) !== 1) {
      unpatchedClaims.push(claim);
      continue;
    }
    if (replacement.trim() === "") {
      // Deletion: drop the sentence and tidy the double space it leaves behind.
      text = text.replace(claim, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n");
      patchedClaims.push(claim);
      continue;
    }
    text = text.replace(claim, replacement);
    replacements.push(replacement);
    patchedClaims.push(claim);
  }

  if (patchedClaims.length === 0) return null;

  // Anything the judge flagged that we did NOT patch must still be reported, so
  // add back the claims that fell outside MAX_PATCH_CLAIMS or the unique-match
  // requirement. The caller keeps their original findings for the footer.
  for (const f of unsupported) {
    if (!patchedClaims.includes(f.claim) && !unpatchedClaims.includes(f.claim)) {
      unpatchedClaims.push(f.claim);
    }
  }

  return { text, replacements, patchedClaims, unpatchedClaims };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. Exported for tests. */
export function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
    // Two is all we need to know it isn't unique.
    if (count > 1) return count;
  }
}

/**
 * Parse `[{"id":1,"replacement":"…"}]`, tolerating fences and surrounding prose.
 * Exported for tests.
 */
export function parseReplacements(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { id?: unknown; replacement?: unknown };
    const id = typeof rec.id === "number" ? rec.id : Number(rec.id);
    if (!Number.isFinite(id)) continue;
    if (typeof rec.replacement !== "string") continue;
    out.set(id, rec.replacement);
  }
  return out;
}
