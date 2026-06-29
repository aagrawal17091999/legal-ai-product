/**
 * Shared vision-native structured pass.
 *
 * Both the translation feature (Feature 2) and OCR feature send the SOURCE
 * document straight to a vision model and get back a typed block model (see
 * src/lib/translate/model.ts) — headings, numbered paragraphs, cause-title
 * key/value blocks, tables, party labels and signatures, with each run carrying
 * italic/bold and a `flagged` marker for spans the model couldn't read.
 *
 * The ONLY thing that differs between the two features is the prompt (translate
 * vs. transcribe) and how the caller wraps the result. Everything else — PDF
 * splitting/batching, the bounded-concurrency vision calls with retries, robust
 * JSON parsing, block coercion and running-header de-dup — lives here so the two
 * pipelines share one battle-tested path.
 */

import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";
import { getAnthropicClient } from "../claude";
import { logError } from "../error-logger";
import { type Block, type Run } from "../translate/model";

// Vision-grade model by default — strong on faded Hindi typewriter/handwriting.
// Override with VISION_MODEL / TRANSLATE_MODEL (e.g. an Opus tier) for the
// hardest scans.
// Default model when the caller doesn't pass one (translation uses this). A
// caller can override per-pass — OCR runs on Haiku, for example.
const DEFAULT_MODEL =
  process.env.VISION_MODEL?.trim() ||
  process.env.TRANSLATE_MODEL?.trim() ||
  process.env.CHAT_MODEL?.trim() ||
  "claude-sonnet-4-6";
const MAX_TOKENS = 16000;

/** Output cap for a vision call, exported for Batch-API request construction. */
export const VISION_MAX_TOKENS = MAX_TOKENS;

/** Resolve the concrete model id for a pass (Batch-API requests need a real id,
 *  not the `undefined` "use default" the translation config passes). */
export function resolveVisionModel(modelOverride?: string | null): string {
  return modelOverride?.trim() || DEFAULT_MODEL;
}

// NOTE: structured outputs (output_config.format) is intentionally NOT used for
// the block model. The full typed block schema is rejected by the API ("compiled
// grammar too large"), and any loose-enough schema lets the model emit `runs` as
// a scalar (" "/null) instead of an array — yielding empty transcriptions. We
// rely on the detailed prompt + robust JSON parsing + coerceBlock() instead. The
// generic `schema` param below is kept for callers that have a small, safe schema.

// Pages per vision call. Kept small so each request stays well under Claude's
// document-block size limit on heavy scans AND so the structured-JSON output
// fits inside MAX_TOKENS. Short filings/orders run in a single call.
const PAGES_PER_BATCH = 6;
// Hard ceiling so a giant upload can't blow past the 300s function limit.
const MAX_TOTAL_PAGES = 150;
// Concurrent vision calls — cuts wall-clock without tripping rate limits.
const CONCURRENCY = 5;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IMAGE_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

function isPdf(mime: string, filename: string): boolean {
  return (mime || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(filename);
}
function isDocx(mime: string, filename: string): boolean {
  return (
    (mime || "").toLowerCase() ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(filename)
  );
}
/** The processing kind for a source — drives batching and `ocrUsed`. */
export function sourceKind(mime: string, filename: string): "pdf" | "image" | "text" {
  if (isDocx(mime, filename)) return "text";
  if (isPdf(mime, filename)) return "pdf";
  return "image";
}

function imageMediaType(mime: string, filename: string): string {
  const m = (mime || "").toLowerCase();
  if (IMAGE_MIME.has(m)) return m === "image/jpg" ? "image/jpeg" : m;
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "image/jpeg";
}

/** One unit of work: a 0-based, inclusive page range (null for non-PDF sources
 *  that are processed whole). `index` preserves reading order across batches. */
export interface BatchPlanItem {
  index: number;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface BatchPlan {
  kind: "pdf" | "image" | "text";
  totalPages: number;
  batches: BatchPlanItem[];
}

/**
 * Plan how a source document will be chunked into vision calls WITHOUT doing any
 * model work. The durable queue stores one row per returned batch and the worker
 * processes them across separate function invocations (each with a fresh budget,
 * which is how arbitrarily large documents avoid the 300s cap). Returns page
 * RANGES only — the worker re-derives the sub-PDF bytes per batch from the stored
 * source via {@link runBatch}.
 *
 * Mirrors the bounds and batch sizing of the old splitPdf; a PDF over the page
 * cap throws the same user-facing message so the upload route can 400.
 */
export async function planBatches(
  buffer: Buffer,
  mime: string,
  filename: string
): Promise<BatchPlan> {
  if (isDocx(mime, filename)) {
    return { kind: "text", totalPages: 1, batches: [{ index: 0, pageStart: null, pageEnd: null }] };
  }
  if (isPdf(mime, filename)) {
    let total: number;
    try {
      const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
      // A password-protected PDF parses (we ignore encryption to read structure)
      // but its page content can't be rendered/extracted — reject it up front with
      // a clear message instead of billing a doomed vision call that fails later.
      if (src.isEncrypted) {
        throw new Error(
          "This PDF is password-protected. Please remove the password and try again."
        );
      }
      total = src.getPageCount();
    } catch (err) {
      // Re-throw our own validation errors (encryption) so the upload route 400s.
      if (err instanceof Error && /password-protected/.test(err.message)) throw err;
      // pdf-lib couldn't parse it — fall back to a single whole-document batch
      // (matches the old single-block fallback for unparseable PDFs).
      return { kind: "pdf", totalPages: 1, batches: [{ index: 0, pageStart: null, pageEnd: null }] };
    }
    if (total === 0) {
      throw new Error("This PDF has no pages. Please upload a valid document.");
    }
    if (total > MAX_TOTAL_PAGES) {
      throw new Error(
        `Document has ${total} pages; this supports up to ${MAX_TOTAL_PAGES}. ` +
          `Please split the file and try again.`
      );
    }
    if (total <= PAGES_PER_BATCH) {
      return { kind: "pdf", totalPages: total, batches: [{ index: 0, pageStart: 0, pageEnd: total - 1 }] };
    }
    const batches: BatchPlanItem[] = [];
    let index = 0;
    for (let start = 0; start < total; start += PAGES_PER_BATCH) {
      batches.push({
        index: index++,
        pageStart: start,
        pageEnd: Math.min(start + PAGES_PER_BATCH, total) - 1,
      });
    }
    return { kind: "pdf", totalPages: total, batches };
  }
  return { kind: "image", totalPages: 1, batches: [{ index: 0, pageStart: null, pageEnd: null }] };
}

/** Extract an inclusive 0-based page range from a PDF buffer into a new sub-PDF. */
async function extractPdfRange(buffer: Buffer, pageStart: number, pageEnd: number): Promise<Buffer> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const sub = await PDFDocument.create();
  const indices: number[] = [];
  for (let i = pageStart; i <= pageEnd; i++) indices.push(i);
  const copied = await sub.copyPages(src, indices);
  copied.forEach((p) => sub.addPage(p));
  return Buffer.from(await sub.save());
}

/** Build the message content for one batch from the raw source buffer. Exported
 *  so the Batch-API submitter can construct the same request body the worker
 *  sends synchronously. */
export async function buildBatchContent(
  buffer: Buffer,
  mime: string,
  filename: string,
  batch: BatchPlanItem,
  prompt: string
): Promise<Array<Record<string, unknown>>> {
  if (isDocx(mime, filename)) {
    const { value } = await mammoth.extractRawText({ buffer });
    return textContent((value || "").trim(), prompt);
  }
  if (isPdf(mime, filename)) {
    const bytes =
      batch.pageStart != null && batch.pageEnd != null
        ? await extractPdfRange(buffer, batch.pageStart, batch.pageEnd)
        : buffer;
    return pdfContent(bytes, prompt);
  }
  return imageContent({ mediaType: imageMediaType(mime, filename), data: buffer }, prompt);
}

function pdfContent(batch: Buffer, prompt: string): Array<Record<string, unknown>> {
  return [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: batch.toString("base64") } },
    { type: "text", text: prompt },
  ];
}
function imageContent(src: { mediaType: string; data: Buffer }, prompt: string): Array<Record<string, unknown>> {
  return [
    { type: "image", source: { type: "base64", media_type: src.mediaType, data: src.data.toString("base64") } },
    { type: "text", text: prompt },
  ];
}
function textContent(text: string, prompt: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: `${prompt}\n\nDOCUMENT TEXT:\n"""\n${text}\n"""` }];
}

/** The parsed result of one batch — the raw `{detected_language, blocks}` object
 *  the model returned, or null if the call failed. Stored as `result_json` on the
 *  batch row and later fed to {@link assembleBlocks} in reading order. */
export type ParsedBatch = { detected_language?: string; blocks?: unknown } | null;

function parseJsonObject(raw: string): ParsedBatch {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Parse a Batch-API result message into a ParsedBatch — the same text→JSON step
 *  callBatch does for synchronous responses, so both paths produce identical rows. */
export function parseVisionMessage(message: Anthropic.Message): ParsedBatch {
  const txt = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseJsonObject(txt);
}

// Run one vision/text call. Never throws — failures return null so the caller
// surfaces them as a flagged block rather than dropping content.
async function callBatch(
  client: Anthropic,
  content: Array<Record<string, unknown>>,
  index: number,
  feature: string,
  model: string,
  schema: Record<string, unknown> | null
): Promise<ParsedBatch> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: content as any }],
        // Structured outputs: force schema-valid JSON when a schema is supplied.
        ...(schema ? { output_config: { format: { type: "json_schema" as const, schema } } } : {}),
      });
      const txt = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const parsed = parseJsonObject(txt);
      if (parsed) return parsed;
      lastErr = new Error("model did not return valid JSON");
    } catch (err) {
      lastErr = err;
    }
    if (attempt < MAX_RETRIES - 1) await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }
  logError({
    category: "extraction",
    message: `${feature} batch ${index} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    error: lastErr,
    severity: "error",
    metadata: { feature, batch: index, model },
  });
  return null;
}

function coerceRun(raw: unknown): Run {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    text: typeof r.text === "string" ? r.text : "",
    italic: r.italic === true,
    bold: r.bold === true,
    flagged: r.flagged === true,
    note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : null,
  };
}
const coerceRuns = (raw: unknown): Run[] => (Array.isArray(raw) ? raw.map(coerceRun) : []);

/** Validate/normalise a raw block from the model into a typed Block, or null. */
function coerceBlock(raw: unknown): Block | null {
  const b = (raw ?? {}) as Record<string, unknown>;
  switch (b.type) {
    case "heading": {
      const level = b.level === 2 ? 2 : b.level === 3 ? 3 : 1;
      return { type: "heading", level, runs: coerceRuns(b.runs) };
    }
    case "paragraph":
      return {
        type: "paragraph",
        number: typeof b.number === "string" && b.number.trim() ? b.number.trim() : null,
        runs: coerceRuns(b.runs),
      };
    case "kv": {
      const rows = Array.isArray(b.rows)
        ? b.rows.map((row) => {
            const rr = (row ?? {}) as Record<string, unknown>;
            return { key: typeof rr.key === "string" ? rr.key : "", value: coerceRuns(rr.value) };
          })
        : [];
      return { type: "kv", rows };
    }
    case "table": {
      const header = Array.isArray(b.header) ? b.header.map((h) => (typeof h === "string" ? h : "")) : [];
      const rows = Array.isArray(b.rows)
        ? b.rows.map((row) => (Array.isArray(row) ? row.map(coerceRuns) : []))
        : [];
      return { type: "table", header, rows };
    }
    case "partyLabel":
      return { type: "partyLabel", runs: coerceRuns(b.runs) };
    case "signature":
      return { type: "signature", runs: coerceRuns(b.runs) };
    default: {
      // Unknown type with runs → treat as a plain paragraph rather than drop it.
      const runs = coerceRuns(b.runs);
      return runs.length ? { type: "paragraph", number: null, runs } : null;
    }
  }
}

/** Drop a heading/partyLabel block that immediately repeats the previous one
 *  (running page-headers that slipped past the prompt's de-dup instruction). */
function dedupeRunningHeaders(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let lastHeaderText = "";
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "partyLabel") {
      const text = block.runs.map((r) => r.text).join("").trim().toLowerCase();
      if (text && text === lastHeaderText) continue;
      lastHeaderText = text;
    } else {
      lastHeaderText = "";
    }
    out.push(block);
  }
  return out;
}

export interface StructuredVisionResult {
  detectedLanguage: string;
  blocks: Block[];
  /** True when a vision pass read the source pixels/PDF (vs. a DOCX text path). */
  ocrUsed: boolean;
}

/**
 * Run the vision call for ONE batch and return its parsed JSON (never throws —
 * a failed call returns null so the caller can mark the batch failed/retry). The
 * durable-queue worker calls this once per batch, each in its own invocation.
 */
export async function runBatch(
  buffer: Buffer,
  mime: string,
  filename: string,
  batch: BatchPlanItem,
  prompt: string,
  feature: string,
  modelOverride?: string,
  schema: Record<string, unknown> | null = null
): Promise<ParsedBatch> {
  const client = getAnthropicClient();
  const model = modelOverride?.trim() || DEFAULT_MODEL;
  const content = await buildBatchContent(buffer, mime, filename, batch, prompt);
  return callBatch(client, content, batch.index, feature, model, schema);
}

/**
 * Combine per-batch parsed results (in reading order) into the final block model.
 * `parsed[i]` is the result of batch index `i`; a null/unparseable entry becomes a
 * flagged paragraph so content is never silently dropped.
 *
 * @param kind source kind from {@link planBatches} — drives `ocrUsed` (a DOCX
 *   text path is the only non-OCR source).
 */
export function assembleBlocks(
  parsed: ParsedBatch[],
  kind: BatchPlan["kind"]
): StructuredVisionResult {
  let detectedLanguage = "Unknown";
  const blocks: Block[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p && typeof p.detected_language === "string" && p.detected_language.trim() && detectedLanguage === "Unknown") {
      detectedLanguage = p.detected_language.trim();
    }
    if (p && Array.isArray(p.blocks)) {
      for (const raw of p.blocks) {
        const block = coerceBlock(raw);
        if (block) blocks.push(block);
      }
    } else {
      // Batch failed to parse — surface it as a flagged paragraph, never drop it.
      blocks.push({
        type: "paragraph",
        number: null,
        runs: [
          {
            text: "",
            flagged: true,
            note: "This section could not be processed automatically and needs manual review.",
          },
        ],
      });
    }
  }

  return {
    detectedLanguage,
    blocks: dedupeRunningHeaders(blocks),
    ocrUsed: kind !== "text",
  };
}

/**
 * Run the vision-native structured pass over a source document.
 *
 * @param buildPrompt receives nothing and returns the full instruction string;
 *   the caller bakes in any feature-specific intent (translate vs. transcribe).
 * @param feature short label used in error logs ("translate" / "ocr").
 * @param modelOverride model id to use for this pass; falls back to DEFAULT_MODEL.
 * @param schema JSON schema to constrain output via structured outputs, or null.
 */
export async function runStructuredVisionPass(
  buffer: Buffer,
  mime: string,
  filename: string,
  buildPrompt: () => string,
  feature: string,
  modelOverride?: string,
  schema: Record<string, unknown> | null = null
): Promise<StructuredVisionResult> {
  const plan = await planBatches(buffer, mime, filename);
  const prompt = buildPrompt();

  // Run batches with bounded concurrency, preserving reading order.
  const parsed: ParsedBatch[] = new Array(plan.batches.length);
  for (let start = 0; start < plan.batches.length; start += CONCURRENCY) {
    const slice = plan.batches.slice(start, start + CONCURRENCY);
    const results = await Promise.all(
      slice.map((b) => runBatch(buffer, mime, filename, b, prompt, feature, modelOverride, schema))
    );
    results.forEach((r, j) => (parsed[slice[j].index] = r));
  }

  return assembleBlocks(parsed, plan.kind);
}
