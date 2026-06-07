/**
 * Tests for the prompt-cache breakpoint helper.
 *   node --experimental-strip-types --test src/lib/rag/__tests__/promptCache.test.ts
 *
 * Caching must (a) place exactly one breakpoint on the last block of the last
 * message, (b) convert a string content to a text block to host the marker,
 * and (c) never mutate the caller's canonical messages array.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCacheBreakpoints,
  cachedSystem,
  countBreakpoints,
} from "../promptCache.ts";

test("places one breakpoint on the last block of the last message", () => {
  const messages = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi" },
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "a" },
        { type: "text" as const, text: "b" },
      ],
    },
  ];
  const out = applyCacheBreakpoints(messages);
  assert.equal(countBreakpoints([], out), 1);
  const last = out[out.length - 1];
  assert.ok(Array.isArray(last.content));
  const blocks = last.content as Array<Record<string, unknown>>;
  assert.ok(!("cache_control" in blocks[0]));
  assert.ok("cache_control" in blocks[1]);
});

test("converts a string-content last message into a cached text block", () => {
  const messages = [{ role: "user" as const, content: "just a string" }];
  const out = applyCacheBreakpoints(messages);
  const last = out[out.length - 1];
  assert.ok(Array.isArray(last.content));
  const blocks = last.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[0].text, "just a string");
  assert.ok("cache_control" in blocks[0]);
});

test("does not mutate the caller's messages array", () => {
  const messages = [{ role: "user" as const, content: "x" }];
  applyCacheBreakpoints(messages);
  assert.equal(messages[0].content, "x"); // still a bare string, no marker
});

test("cachedSystem wraps the prompt as a cached text block", () => {
  const sys = cachedSystem("SYSTEM");
  assert.ok(Array.isArray(sys));
  assert.equal((sys as Array<Record<string, unknown>>)[0].text, "SYSTEM");
  assert.equal(countBreakpoints(sys, []), 1);
});
