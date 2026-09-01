/**
 * Upload size limit shared by every document-ingest surface (translate, OCR,
 * workspace documents) and by the client-side pre-checks that mirror them.
 *
 * It lived as four separate `25 * 1024 * 1024` literals plus six hardcoded
 * "25 MB" strings, so raising it meant finding all ten. One constant + one
 * formatter means the server check, the client pre-check and the label under
 * the file picker can never drift apart again.
 *
 * WHY 50 MB and not higher. The real ceiling on a document is pages, not bytes:
 * `MAX_TOTAL_PAGES = 150` in lib/vision/structured.ts. Scanned court filings run
 * 100–300 KB/page, so a full 150-page document is ~15–45 MB — 50 MB makes the
 * byte cap non-binding against the page cap, which is the point. Going much
 * beyond that buys nothing and costs a lot, because the upload path holds the
 * whole file in memory several times over:
 *
 *   1. `request.formData()` buffers the entire body,
 *   2. `Buffer.from(await file.arrayBuffer())` copies it again,
 *   3. `planBatches` → `PDFDocument.load()` builds pdf-lib's object graph
 *      (another 2–4x the file bytes),
 *   4. the cron worker re-downloads the full source per tick into a Map keyed
 *      by job, then `extractPdfRange` loads it a second time.
 *
 * pm2 runs 2 cluster instances at `max_memory_restart: 900M` over a 0.4–0.8 GB
 * baseline, on an 8 GB box that also runs Postgres and wants the pgvector HNSW
 * index warm in page cache. A killed instance drops other users' in-flight SSE
 * chat streams, so the headroom is not notional.
 *
 * Raising this past ~50 MB therefore needs more than a bigger number here:
 * presigned direct-to-R2 upload from the browser (bypassing nginx and the Node
 * heap entirely) and streaming page extraction in the worker. Also note that at
 * ~3.3 MB/page a 10-page batch would exceed Claude's 32 MB per-request document
 * limit (see lib/extract/vision.ts), so the batch would fail even if it uploaded.
 *
 * nginx must agree: `client_max_body_size` in deploy/nginx/nyayasearch.conf caps
 * the whole request body and returns a bare 413 before Next sees the request.
 * It is set a little above this value for multipart overhead. The workspace
 * route accepts SEVERAL files per request, so a multi-file batch is bounded by
 * nginx's total-body limit, not by this per-file one.
 */

/** Largest single uploaded document, in bytes. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The limit as it appears in user-facing copy, e.g. "50 MB". */
export const MAX_FILE_LABEL = `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB`;

/** Message for a file that is over the limit. `name` prefixes it when given. */
export function tooLargeMessage(name?: string): string {
  return name
    ? `${name} exceeds the ${MAX_FILE_LABEL} limit.`
    : `File exceeds the ${MAX_FILE_LABEL} limit.`;
}
