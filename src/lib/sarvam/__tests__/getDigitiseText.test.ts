import { test, afterEach } from "node:test";
import assert from "node:assert";
import { getDigitiseText } from "../client";

/**
 * Regression tests for parsing Sarvam Doc AI's digitise results.
 *
 * These exist because the published API reference is WRONG about this response.
 * It documents `documents[].pages[].content` holding a Markdown string; the live
 * API returns `documents[].pages[].blocks[]` — each block carrying `text`,
 * `layout_tag` and `reading_order` — and no `content` field at all. Parsing the
 * documented shape silently produced an empty transcript for a job the API
 * reported as fully successful, which is the worst possible failure here: a
 * confident, blank result. The fixtures below mirror a real captured response
 * from a scanned 1954 Supreme Court judgment.
 */

// The client refuses to build a request without a key; the stubbed fetch below
// means it is never actually sent anywhere.
process.env.SARVAM_API_KEY ??= "test-key";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubResults(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/** Shape as the live API actually returns it. */
const LIVE_SHAPE = {
  job_id: "019feb8f",
  type: "digitise",
  status: "completed",
  documents: [
    {
      filename: "judgment.pdf",
      page_count: 2,
      pages: [
        {
          page_num: 2,
          blocks: [
            { block_id: "p2-b2", text: "Second page body.", layout_tag: "paragraph", reading_order: 2 },
            { block_id: "p2-b1", text: "244", layout_tag: "page-number", reading_order: 1 },
          ],
        },
        {
          page_num: 1,
          blocks: [
            { block_id: "p1-b3", text: "THE SALES TAX OFFICER, PILIBHIT", layout_tag: "headline", reading_order: 3 },
            { block_id: "p1-b1", text: "S.C.R.", layout_tag: "header", reading_order: 1 },
            { block_id: "p1-b2", text: "243", layout_tag: "page-number", reading_order: 2 },
            { block_id: "p1-b4", text: "Held, that there is a distinction.", layout_tag: "paragraph", reading_order: 4 },
          ],
        },
      ],
    },
  ],
};

test("parses the live blocks shape rather than the documented `content` field", async () => {
  stubResults(LIVE_SHAPE);
  const { text, pages } = await getDigitiseText("job-1");
  assert.strictEqual(pages, 2, "both pages should yield content");
  assert.ok(text.includes("THE SALES TAX OFFICER, PILIBHIT"));
  assert.ok(text.includes("Held, that there is a distinction."));
  assert.ok(text.includes("Second page body."));
});

test("orders pages by page_num and blocks by reading_order", async () => {
  stubResults(LIVE_SHAPE);
  const { text } = await getDigitiseText("job-1");
  // Fixture deliberately lists page 2 before page 1, and blocks out of order.
  assert.ok(text.indexOf("--- page 1 ---") < text.indexOf("--- page 2 ---"), "pages out of order");
  assert.ok(text.indexOf("S.C.R.") < text.indexOf("THE SALES TAX OFFICER"), "blocks out of order");
  assert.ok(text.indexOf("THE SALES TAX OFFICER") < text.indexOf("Held, that"), "blocks out of order");
});

test("drops printed page numbers but keeps everything else", async () => {
  stubResults(LIVE_SHAPE);
  const { text } = await getDigitiseText("job-1");
  // "243"/"244" are the reporter's printed page numbers — furniture, repeated
  // every page, and carrying no legal content.
  assert.ok(!/^243$/m.test(text), "printed page number leaked into the transcript");
  assert.ok(!/^244$/m.test(text));
  // The running head is NOT dropped here: on page 1 it can be genuine content,
  // and de-duplication happens downstream where full context is available.
  assert.ok(text.includes("S.C.R."));
});

test("emits a page marker per page so running headers can be de-duplicated", async () => {
  stubResults(LIVE_SHAPE);
  const { text } = await getDigitiseText("job-1");
  assert.match(text, /^--- page 1 ---$/m);
  assert.match(text, /^--- page 2 ---$/m);
});

test("still honours a `content` string if the API ever sends one", async () => {
  stubResults({
    documents: [{ pages: [{ page_num: 1, content: "Markdown body from the documented shape." }] }],
  });
  const { text, pages } = await getDigitiseText("job-2");
  assert.strictEqual(pages, 1);
  assert.ok(text.includes("Markdown body from the documented shape."));
});

test("a job with no usable text reports zero pages rather than a blank success", async () => {
  // The caller treats pages === 0 as a failure and falls back to Claude, so this
  // must not look like a successful empty read.
  stubResults({ documents: [{ pages: [{ page_num: 1, blocks: [{ text: "   ", layout_tag: "paragraph" }] }] }] });
  const { text, pages } = await getDigitiseText("job-3");
  assert.strictEqual(pages, 0);
  assert.strictEqual(text, "");
});

test("tolerates missing documents/pages/blocks without throwing", async () => {
  stubResults({ job_id: "x", type: "digitise", status: "completed" });
  const { text, pages } = await getDigitiseText("job-4");
  assert.strictEqual(pages, 0);
  assert.strictEqual(text, "");
});
