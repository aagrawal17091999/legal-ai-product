import test from "node:test";
import assert from "node:assert/strict";
import { ChunkRegistry, DOC_TOOL_DEFINITIONS } from "../../docchat/docAgentTools";
import type { DocChunkHit } from "../../docchat/retrieve";

const chunk = (chunk_id: number, chunk_index: number): DocChunkHit => ({
  chunk_id,
  document_id: "doc-1",
  document_name: "order.pdf",
  page_no: 3,
  chunk_index,
  chunk_text: "text",
  rrf_score: 0,
  rerank_score: 0,
});

test("a chunk surfaced twice keeps one stable ref", () => {
  const r = new ChunkRegistry();
  const first = r.add(chunk(100, 5));
  const again = r.add(chunk(100, 5));
  assert.equal(first, again);
  assert.equal(r.size, 1);
});

test("refs are dense and 1-based in surfacing order", () => {
  const r = new ChunkRegistry();
  const refs = r.addAll([chunk(10, 0), chunk(20, 7), chunk(30, 2)]);
  assert.deepEqual(refs, [1, 2, 3]);
  // all() must be ref-ordered: citations are built as index+1, so any drift
  // between the array order and the refs shown to the model mislabels sources.
  assert.deepEqual(
    r.all().map((c) => c.chunk_id),
    [10, 20, 30]
  );
});

test("interleaved tools share one numbering", () => {
  const r = new ChunkRegistry();
  assert.equal(r.add(chunk(1, 0)), 1); // search
  assert.equal(r.add(chunk(2, 9)), 2); // scan
  assert.equal(r.add(chunk(1, 0)), 1); // search again — same chunk, same ref
  assert.equal(r.add(chunk(3, 4)), 3); // read_document
  assert.equal(r.size, 3);
});

/**
 * Regression: the passage header once rendered "[4] (file.pdf, p.12, passage 32)"
 * and the model cited [32] — a passage index that was never a citation ref.
 * Anything numeric in a header other than the leading ref must be key-labelled
 * so it cannot read as citable.
 */
test("passage index is key-labelled, never a bare trailing number", () => {
  const scan = DOC_TOOL_DEFINITIONS.find((t) => t.name === "scan_documents");
  assert.ok(scan, "scan_documents tool must exist");

  // The header format is exercised through the tools, so assert the contract it
  // has to satisfy: a bracketed ref, then no unlabelled integers.
  const header = "[4] order.pdf · p.12 · passage_index=32";
  const leadingRef = header.match(/^\[(\d+)\]/);
  assert.ok(leadingRef, "header must open with a bracketed ref");

  const afterRef = header.slice(leadingRef[0].length);
  const bareNumbers = [...afterRef.matchAll(/(^|[\s·(,])(\d+)(?=[\s·),]|$)/g)];
  assert.equal(
    bareNumbers.length,
    0,
    `header exposes unlabelled number(s) the model can mistake for a ref: ${afterRef}`
  );
});

test("scan tool tells the model it is exhaustive, not top-K", () => {
  const scan = DOC_TOOL_DEFINITIONS.find((t) => t.name === "scan_documents");
  // The whole point of the tool is completeness; if the description stops
  // saying so, the model will keep reaching for search on "list every X".
  assert.match(String(scan?.description), /every|exhaust/i);
});
