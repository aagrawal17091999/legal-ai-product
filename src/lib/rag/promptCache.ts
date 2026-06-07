import type Anthropic from "@anthropic-ai/sdk";

/**
 * Prompt-caching helpers for the agent loop.
 *
 * Prompt caching is a prefix match: the API caches the rendered prompt up to a
 * `cache_control` breakpoint and re-reads it at ~0.1x input cost on later
 * requests that share the prefix. Render order is tools → system → messages.
 *
 * We use exactly two breakpoints (the cap is 4):
 *   1. The system block — a marker here caches tools + system together. Both are
 *      byte-stable across every turn and every session, so this is a large
 *      shared warm cache.
 *   2. A single ROLLING breakpoint on the last content block of the last
 *      message. Because we only ever append to `messages`, each step's written
 *      breakpoint becomes the next step's read point, so the whole accumulated
 *      conversation (history + tool results) is read from cache incrementally.
 *
 * Caching can be disabled with PROMPT_CACHE=off (for A/B cost comparison).
 */

export const PROMPT_CACHE_ENABLED =
  (process.env.PROMPT_CACHE ?? "on").trim().toLowerCase() !== "off";

const EPHEMERAL = { type: "ephemeral" as const };

/**
 * Wrap a plain system-prompt string as a cached text block (caches tools +
 * system). Returns the bare string when caching is disabled.
 */
export function cachedSystem(
  systemPrompt: string
): string | Anthropic.TextBlockParam[] {
  if (!PROMPT_CACHE_ENABLED) return systemPrompt;
  return [{ type: "text", text: systemPrompt, cache_control: EPHEMERAL }];
}

/**
 * Return a shallow copy of `messages` with a single `cache_control` breakpoint
 * placed on the last content block of the last message. The input array and its
 * message objects are not mutated (we clone the one message we touch), so the
 * caller's canonical history stays free of cache markers.
 *
 * A string `content` is converted to a one-element text block so the marker has
 * somewhere to live.
 */
export function applyCacheBreakpoints(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  if (!PROMPT_CACHE_ENABLED || messages.length === 0) return messages;

  const out = messages.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx];

  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : last.content.map((b) => ({ ...b }));

  if (blocks.length === 0) return messages;

  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: EPHEMERAL,
  } as Anthropic.ContentBlockParam;

  out[lastIdx] = { ...last, content: blocks };
  return out;
}

/** Count cache_control markers in a request (system + messages) — for tests/audit. */
export function countBreakpoints(
  system: string | Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[]
): number {
  let n = 0;
  if (Array.isArray(system)) {
    n += system.filter((b) => "cache_control" in b && b.cache_control).length;
  }
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    n += m.content.filter(
      (b) => "cache_control" in b && (b as { cache_control?: unknown }).cache_control
    ).length;
  }
  return n;
}
