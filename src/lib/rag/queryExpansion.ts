import Anthropic from "@anthropic-ai/sdk";
import { logError } from "../error-logger";

/**
 * Query expansion for fresh retrieval.
 *
 * The retriever (`retrieveChunks`) is built to RRF-fuse several queries, but the
 * agent's search_fresh tool historically passed exactly one. Indian case law is
 * full of doctrinal synonyms (e.g. "pre-emption" / "right of first refusal" /
 * "shufa"; "anticipatory bail" / "s. 438 CrPC") and a single phrasing misses
 * the passages that use the alternative vocabulary. We expand the agent's query
 * into a small set of complementary sub-queries so recall doesn't hinge on one
 * phrasing.
 *
 * The original query is ALWAYS kept as the first element, so expansion can only
 * add recall, never remove the user's exact intent. If the model call fails we
 * fall back to just the original query — expansion is best-effort.
 */

const EXPANSION_MODEL =
  process.env.QUERY_EXPANSION_MODEL?.trim() || "claude-haiku-4-5-20251001";

// How many ADDITIONAL queries to request (the original is always included).
const MAX_EXTRA_QUERIES = 4;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  return new Anthropic({ apiKey });
}

const EXPANSION_PROMPT = `You rewrite a legal search query into a few complementary search queries for an Indian case-law database (Supreme Court + High Courts).

Goal: maximise recall. Produce variants that a relevant judgment might match even if it uses different wording than the original.

Rules:
- Cover doctrinal synonyms and statutory equivalents (e.g. "pre-emption" ↔ "right of first refusal" ↔ "shufa"; "anticipatory bail" ↔ "Section 438 CrPC").
- Vary phrasing: one keyword-style, one natural-question style, one statute/section-anchored if applicable.
- Stay strictly on the SAME legal issue. Do NOT broaden to adjacent topics.
- Each query must be self-contained (no pronouns).
- Return between 1 and ${MAX_EXTRA_QUERIES} additional queries.

Return ONLY a JSON array of strings, e.g. ["query one", "query two"]. No prose.`;

/**
 * Expand a single query into the original plus up to MAX_EXTRA_QUERIES variants.
 * Deduplicates case-insensitively and always returns at least [original].
 */
export async function expandQueries(original: string): Promise<{
  queries: string[];
  expanded: boolean;
}> {
  const base = original.trim();
  if (!base) return { queries: [], expanded: false };

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: EXPANSION_MODEL,
      max_tokens: 400,
      system: EXPANSION_PROMPT,
      messages: [{ role: "user", content: base }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const variants = parseQueryArray(raw);

    const seen = new Set<string>();
    const queries: string[] = [];
    for (const q of [base, ...variants]) {
      const norm = q.trim();
      const key = norm.toLowerCase();
      if (!norm || seen.has(key)) continue;
      seen.add(key);
      queries.push(norm);
      if (queries.length >= MAX_EXTRA_QUERIES + 1) break;
    }

    return { queries, expanded: queries.length > 1 };
  } catch (err) {
    logError({
      category: "chat",
      message: `query expansion failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { query: base, model: EXPANSION_MODEL },
    });
    // Best-effort: degrade to the single original query.
    return { queries: [base], expanded: false };
  }
}

/**
 * Tolerant JSON-array extraction. The model is told to return a bare array, but
 * we defensively pull the first `[...]` block in case it wraps it in prose or a
 * code fence.
 */
function parseQueryArray(raw: string): string[] {
  if (!raw) return [];
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}
