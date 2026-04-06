import Anthropic from "@anthropic-ai/sdk";
import { logError } from "../error-logger";
import type { ChatMessage, SearchFilters } from "@/types";

const QUERY_REWRITE_MODEL = "claude-haiku-4-5-20251001";

export interface QueryUnderstanding {
  /** False for pure chitchat / meta ("thanks", "who are you") — skip retrieval entirely. */
  needs_retrieval: boolean;
  /** 1–3 standalone search queries. The original user message counts as one of them. */
  rewritten_queries: string[];
  /** Short hypothetical passage (HyDE) that the answer might contain — used as an extra embedding target. */
  hyde_passage: string;
  /** Filters extracted from natural-language phrasing (e.g. "Delhi HC in 2020"). Merged with, not replacing, session filters. */
  implicit_filters: Partial<SearchFilters>;
  /** Audit metadata, not used in the pipeline itself but persisted to rag_pipeline_steps for debugging. */
  audit: {
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    raw_response: string | null;
    /** True if the Haiku call or JSON parse failed and we fell back to using the raw user message. */
    fallback: boolean;
    fallback_reason: string | null;
  };
}

const SYSTEM = `You rewrite legal research questions for a retrieval system over Indian case law.

Given the conversation so far and the user's latest message, produce standalone search queries that a search engine can use in isolation (no pronouns like "it" or "that case"; no references to "the previous question"). Also try to extract any filters the user implied in natural language.

Output STRICT JSON matching this schema, with no prose and no markdown:
{
  "needs_retrieval": boolean,
  "rewritten_queries": string[],    // 1 to 3 queries. Prefer 1 for simple questions.
  "hyde_passage": string,            // 2-4 sentence hypothetical excerpt from an Indian judgment that would answer the question. Empty string if needs_retrieval is false.
  "implicit_filters": {
    "court": string | null,          // e.g. "Supreme Court of India", "Delhi High Court"
    "yearFrom": number | null,
    "yearTo": number | null,
    "actCited": string | null,       // e.g. "Arbitration and Conciliation Act, 1996"
    "judgeName": string | null
  }
}

Rules:
- Set needs_retrieval=false ONLY for pure chitchat ("hi", "thanks", "who are you", "what can you do"). When in doubt, set true.
- rewritten_queries[0] must be the user's intent, rephrased as a complete standalone question if context is needed.
- Resolve pronouns from history. If the user says "what about Delhi HC?" after a question about Article 21, rewrite to "Delhi High Court judgments on Article 21 right to privacy".
- Only populate implicit_filters when the user is explicit ("Supreme Court", "in 2020", "under Section 138 NI Act"). If uncertain, use null.
- Never invent filter values.`;

const MAX_HISTORY_TURNS = 6;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }
  return new Anthropic({ apiKey });
}

/**
 * Call Haiku to rewrite the user's message and extract implicit filters.
 * Falls back to a safe default (use the raw user message, no implicit filters)
 * if the model call or JSON parse fails — retrieval is still possible.
 */
export async function understandQuery(
  userMessage: string,
  history: ChatMessage[]
): Promise<QueryUnderstanding> {
  const recent = history.slice(-MAX_HISTORY_TURNS).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const userBlock = `CONVERSATION HISTORY (most recent last):
${
  recent.length === 0
    ? "(none)"
    : recent.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")
}

USER'S LATEST MESSAGE:
${userMessage}

Return the JSON now.`;

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: QUERY_REWRITE_MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{ role: "user", content: userBlock }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock ? textBlock.text.trim() : "";
    const usage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      model: response.model,
    };

    const parsed = parseStrict(raw);
    if (!parsed) {
      return fallback(userMessage, {
        model: usage.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        raw_response: raw,
        reason: "unparseable-json",
      });
    }
    return normalize(parsed, userMessage, {
      model: usage.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      raw_response: raw,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logError({
      category: "chat",
      message: reason,
      error: err,
      severity: "warning",
      metadata: { step: "understandQuery" },
    });
    return fallback(userMessage, {
      model: QUERY_REWRITE_MODEL,
      input_tokens: null,
      output_tokens: null,
      raw_response: null,
      reason,
    });
  }
}

function parseStrict(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Tolerate code fences even though the prompt forbids them.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    // Try to extract the first {...} block.
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function normalize(
  parsed: Record<string, unknown>,
  userMessage: string,
  audit: {
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    raw_response: string | null;
  }
): QueryUnderstanding {
  const needs =
    typeof parsed.needs_retrieval === "boolean" ? parsed.needs_retrieval : true;

  const rawQueries = Array.isArray(parsed.rewritten_queries)
    ? (parsed.rewritten_queries as unknown[]).filter(
        (q): q is string => typeof q === "string" && q.trim().length > 0
      )
    : [];
  const queries = rawQueries.slice(0, 3);
  if (queries.length === 0) queries.push(userMessage);

  const hyde =
    typeof parsed.hyde_passage === "string" ? parsed.hyde_passage.trim() : "";

  const rawFilters =
    parsed.implicit_filters && typeof parsed.implicit_filters === "object"
      ? (parsed.implicit_filters as Record<string, unknown>)
      : {};

  const implicit: Partial<SearchFilters> = {};
  if (typeof rawFilters.court === "string" && rawFilters.court.trim()) {
    implicit.court = rawFilters.court.trim();
  }
  if (typeof rawFilters.yearFrom === "number") {
    implicit.yearFrom = rawFilters.yearFrom;
  }
  if (typeof rawFilters.yearTo === "number") {
    implicit.yearTo = rawFilters.yearTo;
  }
  if (typeof rawFilters.actCited === "string" && rawFilters.actCited.trim()) {
    implicit.actCited = rawFilters.actCited.trim();
  }
  if (typeof rawFilters.judgeName === "string" && rawFilters.judgeName.trim()) {
    implicit.judgeName = rawFilters.judgeName.trim();
  }

  return {
    needs_retrieval: needs,
    rewritten_queries: queries,
    hyde_passage: hyde,
    implicit_filters: implicit,
    audit: {
      model: audit.model,
      input_tokens: audit.input_tokens,
      output_tokens: audit.output_tokens,
      raw_response: audit.raw_response,
      fallback: false,
      fallback_reason: null,
    },
  };
}

function fallback(
  userMessage: string,
  audit: {
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    raw_response: string | null;
    reason: string;
  }
): QueryUnderstanding {
  return {
    needs_retrieval: true,
    rewritten_queries: [userMessage],
    hyde_passage: "",
    implicit_filters: {},
    audit: {
      model: audit.model,
      input_tokens: audit.input_tokens,
      output_tokens: audit.output_tokens,
      raw_response: audit.raw_response,
      fallback: true,
      fallback_reason: audit.reason,
    },
  };
}

/**
 * Merge implicit filters from query understanding with the user's explicit
 * session filters. Session filters always win on conflict — the user picked
 * them in the UI and we should not silently override.
 */
export function mergeFilters(
  sessionFilters: SearchFilters,
  implicit: Partial<SearchFilters>
): SearchFilters {
  const merged: SearchFilters = { ...implicit, ...sessionFilters };
  // `sessionFilters` may have explicitly empty strings; strip those so they
  // don't mask implicit values.
  for (const key of Object.keys(merged) as (keyof SearchFilters)[]) {
    const v = merged[key];
    if (v === "" || v === undefined || v === null) {
      delete merged[key];
    }
  }
  return merged;
}
