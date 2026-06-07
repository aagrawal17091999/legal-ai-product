import Anthropic from "@anthropic-ai/sdk";
import { logError } from "../error-logger";

/**
 * Question decomposition.
 *
 * Compound legal questions ("can pre-emption be presumed for commercial property,
 * and does a co-sharer's right differ?") bundle several distinct sub-issues. A
 * single retrieval over the whole sentence under-serves each part. We split a
 * compound question into focused sub-questions so the agent can retrieve for each
 * and synthesise — the way a researcher breaks a brief into issues.
 *
 * Balanced posture: only split questions that are *genuinely* multi-issue. Simple
 * questions return `{ isCompound: false, subQuestions: [original] }` and skip the
 * extra retrieval. Best-effort — any failure degrades to the single original.
 */

const DECOMPOSE_MODEL =
  process.env.DECOMPOSE_MODEL?.trim() || "claude-haiku-4-5-20251001";

const MAX_SUBQUESTIONS = 4;

const SYSTEM_PROMPT = `You split a legal research question into its distinct sub-issues for an Indian case-law database.

Decompose ONLY if the question genuinely bundles separate legal issues that would be researched separately (different doctrines, different statutory provisions, or a main rule plus a distinct exception/condition). Do NOT split a single focused question, and do NOT invent sub-issues the user didn't ask about.

Rules:
- Each sub-question must be self-contained (no pronouns) and independently researchable.
- Preserve the user's scope — do not broaden to adjacent topics.
- Between 2 and ${MAX_SUBQUESTIONS} sub-questions when compound; otherwise none.

Return ONLY JSON: {"compound": boolean, "sub_questions": string[]}. If not compound, return {"compound": false, "sub_questions": []}.`;

export interface DecomposeResult {
  isCompound: boolean;
  subQuestions: string[];
}

export async function decomposeQuestion(
  question: string
): Promise<DecomposeResult> {
  const base = question.trim();
  if (!base) return { isCompound: false, subQuestions: [base] };

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: DECOMPOSE_MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: base }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    return parseDecomposition(raw, base);
  } catch (err) {
    logError({
      category: "chat",
      message: `decomposition failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { question: base, model: DECOMPOSE_MODEL },
    });
    return { isCompound: false, subQuestions: [base] };
  }
}

/**
 * Parse the judge's JSON. Exported for unit testing. Tolerant of prose/fences
 * around the object. Caps and dedupes sub-questions; falls back to the original
 * when not compound or when parsing fails.
 */
export function parseDecomposition(
  raw: string,
  original: string
): DecomposeResult {
  const fallback: DecomposeResult = { isCompound: false, subQuestions: [original] };
  if (!raw) return fallback;

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (parsed?.compound !== true) return fallback;

    const subs = Array.isArray(parsed.sub_questions) ? parsed.sub_questions : [];
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const s of subs) {
      if (typeof s !== "string") continue;
      const norm = s.trim();
      const key = norm.toLowerCase();
      if (!norm || seen.has(key)) continue;
      seen.add(key);
      cleaned.push(norm);
      if (cleaned.length >= MAX_SUBQUESTIONS) break;
    }

    // A "compound" verdict with <2 usable sub-questions isn't actionable.
    if (cleaned.length < 2) return fallback;
    return { isCompound: true, subQuestions: cleaned };
  } catch {
    return fallback;
  }
}
