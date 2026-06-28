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

type Source =
  | { kind: "pdf"; batches: Buffer[] }
  | { kind: "image"; mediaType: string; data: Buffer }
  | { kind: "text"; text: string };

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
function imageMediaType(mime: string, filename: string): string {
  const m = (mime || "").toLowerCase();
  if (IMAGE_MIME.has(m)) return m === "image/jpg" ? "image/jpeg" : m;
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "image/jpeg";
}

/** Split a PDF into page-range sub-PDFs so each vision call stays bounded. */
async function splitPdf(buffer: Buffer): Promise<Buffer[]> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  if (total > MAX_TOTAL_PAGES) {
    throw new Error(
      `Document has ${total} pages; this supports up to ${MAX_TOTAL_PAGES}. ` +
        `Please split the file and try again.`
    );
  }
  if (total <= PAGES_PER_BATCH) return [buffer];

  const batches: Buffer[] = [];
  for (let start = 0; start < total; start += PAGES_PER_BATCH) {
    const sub = await PDFDocument.create();
    const indices: number[] = [];
    for (let i = start; i < Math.min(start + PAGES_PER_BATCH, total); i++) indices.push(i);
    const copied = await sub.copyPages(src, indices);
    copied.forEach((p) => sub.addPage(p));
    batches.push(Buffer.from(await sub.save()));
  }
  return batches;
}

async function prepareSource(buffer: Buffer, mime: string, filename: string): Promise<Source> {
  if (isDocx(mime, filename)) {
    const { value } = await mammoth.extractRawText({ buffer });
    return { kind: "text", text: (value || "").trim() };
  }
  if (isPdf(mime, filename)) {
    try {
      return { kind: "pdf", batches: await splitPdf(buffer) };
    } catch (err) {
      // pdf-lib couldn't parse it (or it's over the page cap which we re-throw):
      // a page-cap error must surface; anything else falls back to a single block.
      if (err instanceof Error && /supports up to/.test(err.message)) throw err;
      return { kind: "pdf", batches: [buffer] };
    }
  }
  // Treat everything else as an image.
  return { kind: "image", mediaType: imageMediaType(mime, filename), data: buffer };
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

type ParsedBatch = { detected_language?: string; blocks?: unknown } | null;

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

// Run one vision/text call. Never throws — failures return null so the caller
// surfaces them as a flagged block rather than dropping content.
async function callBatch(
  client: Anthropic,
  content: Array<Record<string, unknown>>,
  index: number,
  feature: string,
  model: string
): Promise<ParsedBatch> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: content as any }],
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
 * Run the vision-native structured pass over a source document.
 *
 * @param buildPrompt receives nothing and returns the full instruction string;
 *   the caller bakes in any feature-specific intent (translate vs. transcribe).
 * @param feature short label used in error logs ("translate" / "ocr").
 * @param modelOverride model id to use for this pass; falls back to DEFAULT_MODEL.
 */
export async function runStructuredVisionPass(
  buffer: Buffer,
  mime: string,
  filename: string,
  buildPrompt: () => string,
  feature: string,
  modelOverride?: string
): Promise<StructuredVisionResult> {
  const client = getAnthropicClient();
  const model = modelOverride?.trim() || DEFAULT_MODEL;
  const source = await prepareSource(buffer, mime, filename);
  const prompt = buildPrompt();

  const contents: Array<Array<Record<string, unknown>>> =
    source.kind === "pdf"
      ? source.batches.map((b) => pdfContent(b, prompt))
      : source.kind === "image"
        ? [imageContent(source, prompt)]
        : [textContent(source.text, prompt)];

  // Run batches with bounded concurrency, preserving order.
  const parsed: ParsedBatch[] = new Array(contents.length);
  for (let start = 0; start < contents.length; start += CONCURRENCY) {
    const slice = contents.slice(start, start + CONCURRENCY);
    const results = await Promise.all(slice.map((c, j) => callBatch(client, c, start + j, feature, model)));
    results.forEach((r, j) => (parsed[start + j] = r));
  }

  let detectedLanguage = "Unknown";
  const blocks: Block[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p && i === 0 && typeof p.detected_language === "string" && p.detected_language.trim()) {
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
    ocrUsed: source.kind !== "text",
  };
}
