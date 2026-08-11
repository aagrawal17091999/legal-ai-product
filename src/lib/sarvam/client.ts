/**
 * Sarvam Doc AI client — the OCR *reading* step.
 *
 * Sarvam Vision is purpose-built for Indian-language documents (22 scheduled
 * languages + English) and reads degraded court scans — faded typewriter ink,
 * Devanagari/regional scripts, stamps — more reliably than a general vision
 * model, at ₹0.50/page. It returns per-page Markdown, NOT the typed block model
 * this app renders from, so it only replaces the *reading* half of the old
 * single Claude vision pass; Claude still structures (and, for the translation
 * feature, translates) that text into blocks. See src/lib/jobs/sarvam-ocr.ts.
 *
 * The API is asynchronous: submit a digitise job, poll its status until terminal,
 * then fetch results. We use GET /results (plain JSON) rather than /download-url
 * (a ZIP) so no archive dependency is needed.
 *
 * Two hard limits shape the queue design in jobs/sarvam-ocr.ts:
 *   - 10 pages per job (so a batch unit is at most 10 pages)
 *   - 10 requests/minute, ACCOUNT-WIDE and identical on every plan tier — this
 *     one cannot be bought around, so the queue rate-limits itself.
 */

const BASE_URL = process.env.SARVAM_BASE_URL?.trim() || "https://api.sarvam.ai";

/** Sarvam's per-job page cap. A batch unit must never exceed this. */
export const SARVAM_MAX_PAGES_PER_JOB = 10;

/** Account-wide requests/minute for Doc AI. Same on every plan — not raisable. */
export const SARVAM_RATE_LIMIT_PER_MIN =
  Number(process.env.SARVAM_RATE_LIMIT_PER_MIN) || 10;

/** Max input characters for one /translate call on sarvam-translate:v1. Kept a
 *  little under the documented 2000 so a chunk can't trip the limit on rounding. */
export const SARVAM_TRANSLATE_MAX_CHARS =
  Number(process.env.SARVAM_TRANSLATE_MAX_CHARS) || 1800;

/** Max input characters for /text-lid. */
const LID_MAX_CHARS = 1000;

/** Out of Sarvam credits (HTTP 402). The whole pipeline falls back to Claude
 *  vision when this happens, and the worker logs a critical "top up" alarm. */
export class SarvamOutOfCreditsError extends Error {
  constructor(message = "Sarvam account has no credits") {
    super(message);
    this.name = "SarvamOutOfCreditsError";
  }
}

/** Rate limited (HTTP 429). The unit is returned to the queue untouched and
 *  retried on a later tick rather than burning an attempt. */
export class SarvamRateLimitError extends Error {
  constructor(message = "Sarvam rate limit exceeded") {
    super(message);
    this.name = "SarvamRateLimitError";
  }
}

/** Any other Sarvam failure (4xx/5xx/network). */
export class SarvamError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "SarvamError";
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.SARVAM_API_KEY?.trim();
  if (!key) throw new SarvamError("SARVAM_API_KEY is not set");
  return key;
}

/**
 * Whether to route OCR reading through Sarvam. Off unless explicitly switched on
 * AND a key is present — with it off, batch units start `pending` and every page
 * is read by Claude vision, which is the original (costlier) pipeline.
 */
export function isSarvamEnabled(): boolean {
  return (
    process.env.SARVAM_OCR_ENABLED === "on" && Boolean(process.env.SARVAM_API_KEY?.trim())
  );
}

/**
 * Whether Sarvam can read this source at all. Doc AI accepts PDF, PNG and JPG —
 * notably NOT WebP, which this app does accept on upload. Checking up front
 * keeps a WebP out of the Sarvam phase entirely instead of letting it round-trip
 * to a rejection and back to Claude.
 */
export function sarvamCanRead(mime: string, filename: string): boolean {
  const m = (mime || "").toLowerCase();
  if (m === "application/pdf" || m === "image/png" || m === "image/jpeg" || m === "image/jpg") {
    return true;
  }
  if (m) return false;
  return /\.(pdf|png|jpe?g)$/i.test(filename || "");
}

/** Map a non-OK response onto the typed errors the worker branches on. */
async function raiseFor(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => "");
  const detail = body.slice(0, 500);
  if (res.status === 402) throw new SarvamOutOfCreditsError(`${what}: ${detail}`);
  if (res.status === 429) throw new SarvamRateLimitError(`${what}: ${detail}`);
  throw new SarvamError(`${what} failed (${res.status}): ${detail}`, res.status);
}

/**
 * Submit a digitise job. `buffer` must be at most SARVAM_MAX_PAGES_PER_JOB pages.
 * Returns the Sarvam job id to poll.
 *
 * `language` is deliberately omitted: the source language is exactly what we do
 * not know up front (the app auto-detects it), and the field is optional.
 * `auto_orient` matters for phone photos of judgments and rotated scans.
 */
export async function submitDigitise(
  buffer: Buffer,
  mime: string,
  filename: string
): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime || "application/pdf" }),
    filename || "document.pdf"
  );
  form.append("output_format", "md");
  form.append("auto_orient", "true");

  const res = await fetch(`${BASE_URL}/doc-ai/v1/job/digitise`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey() },
    body: form,
  });
  if (!res.ok) await raiseFor(res, "Sarvam digitise submit");

  const data = (await res.json()) as { job_id?: string };
  if (!data.job_id) throw new SarvamError("Sarvam digitise returned no job_id");
  return data.job_id;
}

export type SarvamJobStatus =
  | "completed"
  | "partially_completed"
  | "failed"
  | "rejected"
  | string;

export interface SarvamStatus {
  status: SarvamJobStatus;
  pagesTotal: number;
  pagesSucceeded: number;
  pagesFailed: number;
}

/** Terminal statuses — results are only available once one of these is reached. */
export function isTerminal(status: SarvamJobStatus): boolean {
  return (
    status === "completed" ||
    status === "partially_completed" ||
    status === "failed" ||
    status === "rejected"
  );
}

export async function getJobStatus(jobId: string): Promise<SarvamStatus> {
  const res = await fetch(`${BASE_URL}/doc-ai/v1/job/${encodeURIComponent(jobId)}/status`, {
    headers: { "api-subscription-key": apiKey() },
  });
  if (!res.ok) await raiseFor(res, "Sarvam job status");

  const data = (await res.json()) as {
    status?: string;
    usage?: { pages_total?: number; pages_succeeded?: number; pages_failed?: number };
  };
  return {
    status: data.status ?? "unknown",
    pagesTotal: data.usage?.pages_total ?? 0,
    pagesSucceeded: data.usage?.pages_succeeded ?? 0,
    pagesFailed: data.usage?.pages_failed ?? 0,
  };
}

/**
 * Detect the source language of a document.
 *
 * Needed because sarvam-translate:v1 requires an explicit `source_language_code`
 * (only the older mayura:v1 accepts "auto"), and the source language is exactly
 * what this product does not know up front — it's auto-detected per upload.
 *
 * Returns null when the language can't be determined OR isn't one of the 11
 * languages /text-lid covers (it recognises fewer languages than /translate can
 * translate — Urdu, Assamese, Santali and others are absent). A null return is a
 * signal to translate with Claude instead, not an error.
 */
export async function identifyLanguage(text: string): Promise<string | null> {
  const sample = text.trim().slice(0, LID_MAX_CHARS);
  if (!sample) return null;

  const res = await fetch(`${BASE_URL}/text-lid`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ input: sample }),
  });
  if (!res.ok) await raiseFor(res, "Sarvam language detection");

  const data = (await res.json()) as { language_code?: string | null };
  const code = data.language_code?.trim();
  return code || null;
}

/** Greedily pack pieces into strings of at most `max` chars, joined by `sep`. */
function pack(pieces: string[], max: number, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + sep.length + p.length > max) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + sep + p : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split text into translate-sized chunks, always breaking at whitespace.
 *
 * Boundaries are chosen in decreasing order of preference: paragraph break,
 * then sentence end (including the Devanagari danda ।), then word break. The
 * word-break level is what makes this safe — an earlier version hard-split at a
 * fixed offset, which could slice a word in half and send each half to the
 * translator separately, silently corrupting the text. A chunk boundary costs
 * some cross-sentence context; splitting a word costs correctness.
 *
 * The only case that still hard-splits is a single "word" longer than the limit,
 * which is not natural language (an unbroken 1,800-character token) and cannot
 * be divided any other way.
 */
export function chunkForTranslate(
  text: string,
  maxChars: number = SARVAM_TRANSLATE_MAX_CHARS
): string[] {
  const units: string[] = [];

  for (const para of text.split(/\n{2,}/)) {
    const block = para.trim();
    if (!block) continue;
    if (block.length <= maxChars) {
      units.push(block);
      continue;
    }

    // Too long for one request: break on sentence ends, keeping each terminator
    // with its sentence.
    for (const sentence of pack(block.split(/(?<=[.!?।])\s+/), maxChars, " ")) {
      if (sentence.length <= maxChars) {
        units.push(sentence);
        continue;
      }
      // A single sentence over the limit: fall back to word boundaries.
      for (const words of pack(sentence.split(/\s+/), maxChars, " ")) {
        if (words.length <= maxChars) {
          units.push(words);
          continue;
        }
        // One unbroken token longer than the limit — nothing left but to cut it.
        for (let i = 0; i < words.length; i += maxChars) {
          units.push(words.slice(i, i + maxChars));
        }
      }
    }
  }

  // Pack units back up to the limit so we spend as few requests as possible.
  return pack(units, maxChars, "\n\n");
}

/** Translate one chunk (≤ SARVAM_TRANSLATE_MAX_CHARS). */
async function translateChunk(
  input: string,
  sourceCode: string,
  targetCode: string
): Promise<string> {
  const res = await fetch(`${BASE_URL}/translate`, {
    method: "POST",
    headers: { "api-subscription-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      source_language_code: sourceCode,
      target_language_code: targetCode,
      model: "sarvam-translate:v1",
      // Legal documents: keep numerals in the international form the source uses,
      // so section numbers, dates and case numbers stay recognisable.
      numerals_format: "international",
    }),
  });
  if (!res.ok) await raiseFor(res, "Sarvam translate");

  const data = (await res.json()) as { translated_text?: string };
  return data.translated_text ?? "";
}

/**
 * Translate page-marked Markdown, preserving the "--- page N ---" markers.
 *
 * Markers are re-emitted untranslated and chunks never span a page, so the
 * downstream structuring pass can still tell where pages break and drop repeated
 * running headers. Chunks within a page run with bounded concurrency — the
 * account-wide translate limit is 60 req/min, and a 10-page unit is ~15-20 calls.
 */
export async function translatePageText(
  text: string,
  sourceCode: string,
  targetCode: string,
  concurrency = 3
): Promise<string> {
  const out: string[] = [];

  // Split on the page markers this module's getDigitiseText() emits, keeping them.
  const sections = text.split(/^(--- page \d+ ---)$/m);
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (/^--- page \d+ ---$/.test(section)) { out.push(section); continue; }
    const body = section.trim();
    if (!body) continue;

    const chunks = chunkForTranslate(body);
    const translated: string[] = new Array(chunks.length);
    for (let start = 0; start < chunks.length; start += concurrency) {
      const slice = chunks.slice(start, start + concurrency);
      const results = await Promise.all(
        slice.map((c) => translateChunk(c, sourceCode, targetCode))
      );
      results.forEach((r, j) => (translated[start + j] = r));
    }
    out.push(translated.join("\n\n"));
  }

  return out.join("\n").trim();
}

export interface SarvamDigitiseText {
  /** All pages' text joined in reading order, separated by a page marker. */
  text: string;
  /** Pages that actually produced content — what we meter on. */
  pages: number;
}

/**
 * Layout tags that are page FURNITURE, not document content: the reporter's
 * running head ("S.C.R.", "SUPREME COURT REPORTS") and the printed page number,
 * both repeated on every page. Left in, they would be transcribed once per page
 * and pollute the block model. Dropping them here is safe in a way that dropping
 * body text never would be — these carry no legal content.
 */
const FURNITURE_TAGS = new Set(["page-number", "page-footer", "footer"]);

/**
 * Fetch a terminal digitise job's results and flatten them to plain text.
 *
 * NOTE ON THE RESPONSE SHAPE: the published API reference describes
 * `documents[].pages[].content` holding a Markdown string. The live API returns
 * something different and richer — `documents[].pages[].blocks[]`, each with
 * `text`, `layout_tag` and `reading_order`, and no `content` field at all. This
 * parser follows the live shape (verified against a real scanned judgment); a
 * `content` string is still honoured if the API ever starts sending one.
 *
 * A page marker is kept between pages so the downstream Claude pass can tell
 * where pages break, which is what lets it drop repeated running headers rather
 * than emitting the court name once per page.
 */
export async function getDigitiseText(jobId: string): Promise<SarvamDigitiseText> {
  const res = await fetch(`${BASE_URL}/doc-ai/v1/job/${encodeURIComponent(jobId)}/results`, {
    headers: { "api-subscription-key": apiKey() },
  });
  if (!res.ok) await raiseFor(res, "Sarvam job results");

  const data = (await res.json()) as {
    documents?: Array<{
      pages?: Array<{
        page_num?: number;
        page_number?: number;
        content?: string;
        blocks?: Array<{ text?: string; layout_tag?: string; reading_order?: number }>;
      }>;
    }>;
  };

  const parts: string[] = [];
  let pages = 0;

  for (const doc of data.documents ?? []) {
    const ordered = [...(doc.pages ?? [])].sort(
      (a, b) => (a.page_num ?? a.page_number ?? 0) - (b.page_num ?? b.page_number ?? 0)
    );
    for (const page of ordered) {
      const blocks = [...(page.blocks ?? [])]
        .sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0))
        .filter((b) => !FURNITURE_TAGS.has((b.layout_tag ?? "").toLowerCase()))
        .map((b) => (b.text ?? "").trim())
        .filter(Boolean);

      // Prefer blocks; fall back to `content` for forward compatibility.
      const body = blocks.length ? blocks.join("\n\n") : (page.content ?? "").trim();
      if (!body) continue;

      pages++;
      parts.push(`--- page ${page.page_num ?? page.page_number ?? pages} ---\n${body}`);
    }
  }

  return { text: parts.join("\n\n"), pages };
}
