import { getAnthropicClient } from "../claude";
import { logError } from "../error-logger";

/**
 * Sufficiency reflection (#1 — search → reflect → re-search).
 *
 * After the agent has gathered evidence and is ready to answer, this gate asks a
 * fast judge whether the gathered cases actually answer the question, or whether
 * one more targeted search would help. It only fires when retrieval looked weak
 * (an abstention or low rerank scores) — so a confident answer on strong
 * evidence is never delayed.
 *
 * Best-effort: any failure returns `sufficient: true` so the agent proceeds.
 */

const REFLECT_MODEL = process.env.REFLECT_MODEL?.trim() || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a legal-research supervisor. Given a user's question and a summary of the case-law evidence an assistant has gathered, decide whether the evidence is sufficient to answer accurately, or whether ONE more targeted database search would materially help.

Judge strictly on coverage of the question's legal issue(s). If the gathered cases are on-point and cover the issue, it's sufficient. If they're tangential, missing a sub-issue, or thin, propose a single better search query (different phrasing or a narrower sub-issue) — do NOT propose searches for issues the user didn't ask about.

Return ONLY JSON: {"sufficient": boolean, "next_query": string|null, "reason": string}. When sufficient, next_query is null.`;

export interface ReflectResult {
  sufficient: boolean;
  nextQuery: string | null;
  reason: string;
}

export async function reflectSufficiency(params: {
  userMessage: string;
  evidenceSummary: string;
}): Promise<ReflectResult> {
  try {
    const client = getAnthropicClient();

    const response = await client.messages.create({
      model: REFLECT_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `USER QUESTION:\n${params.userMessage}\n\nEVIDENCE GATHERED:\n${params.evidenceSummary || "(none)"}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    return parseReflection(raw);
  } catch (err) {
    logError({
      category: "chat",
      message: `reflection failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { model: REFLECT_MODEL },
    });
    return { sufficient: true, nextQuery: null, reason: "reflection unavailable" };
  }
}

/** Parse the reflection JSON. Exported for unit testing. Defaults to sufficient. */
export function parseReflection(raw: string): ReflectResult {
  const fallback: ReflectResult = { sufficient: true, nextQuery: null, reason: "" };
  if (!raw) return fallback;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return fallback;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const sufficient = parsed?.sufficient !== false; // default true unless explicitly false
    const nextQueryRaw = parsed?.next_query;
    const nextQuery =
      !sufficient && typeof nextQueryRaw === "string" && nextQueryRaw.trim()
        ? nextQueryRaw.trim()
        : null;
    return {
      sufficient: sufficient || nextQuery === null,
      nextQuery,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return fallback;
  }
}
