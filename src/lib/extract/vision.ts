/**
 * Vision-LLM OCR for scanned PDFs and images.
 *
 * Mirrors the offline pipeline's approach (pipeline/pdf_ocr.py): the embedded
 * text layer is read first (cheaply, by the caller), and only when it is too
 * sparse to be real do we send the file to Claude, which handles handwriting
 * and degraded scans far better than Tesseract/Textract. Here it runs at
 * request time instead of in the batch pipeline.
 *
 * Claude's `document` content block natively extracts a PDF's text and runs
 * visual OCR on page-images, so we send the whole PDF in one block rather than
 * rasterising pages ourselves.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../claude";
import { logError } from "../error-logger";

// OCR runs on Haiku by default: it's markedly faster and cheaper, which keeps
// multi-page scans under the 300s function limit. Override with OCR_MODEL (e.g.
// claude-sonnet-4-6) if transcription quality on a hard scan isn't good enough.
export const VISION_MODEL = process.env.OCR_MODEL?.trim() || "claude-haiku-4-5";

// Claude's document block accepts up to 100 PDF pages / 32MB per request. User
// uploads (certificates, contracts, short filings) sit well under this; larger
// scans are rejected with a clear error rather than silently truncated.
const MAX_PDF_PAGES = 100;
const MAX_OCR_TOKENS = 16000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

const OCR_PROMPT =
  "This is a scan of a legal/official document. Extract every word of text from " +
  "all pages, including handwritten annotations, stamps, seals, and marginalia. " +
  "Preserve paragraph breaks and reading order. Do not summarise, translate, add " +
  "commentary, or wrap the output in code fences. Output the raw transcribed text only.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callVision(
  content: Array<Record<string, unknown>>
): Promise<string> {
  const client = getAnthropicClient();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await client.messages.create({
        model: VISION_MODEL,
        max_tokens: MAX_OCR_TOKENS,
        messages: [
          {
            role: "user",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: content as any,
          },
        ],
      });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    } catch (err) {
      lastErr = err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  logError({
    category: "extraction",
    message: `Vision OCR failed after ${MAX_RETRIES} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
    error: lastErr,
    severity: "error",
    metadata: { function: "callVision", model: VISION_MODEL },
  });
  throw new Error(
    `Vision OCR failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

/** OCR a (scanned) PDF by sending it to Claude as a base64 document block. */
export async function extractPdfWithVision(
  pdf: Buffer,
  pageCount: number
): Promise<string> {
  if (pageCount > MAX_PDF_PAGES) {
    throw new Error(
      `Document has ${pageCount} pages; vision OCR supports up to ${MAX_PDF_PAGES}. ` +
        `Split the file or provide one with an embedded text layer.`
    );
  }
  return callVision([
    {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdf.toString("base64"),
      },
    },
    { type: "text", text: OCR_PROMPT },
  ]);
}

/** OCR an image (JPG/PNG) by sending it to Claude as a base64 image block. */
export async function extractImageWithVision(
  image: Buffer,
  mediaType: string
): Promise<string> {
  return callVision([
    {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: image.toString("base64"),
      },
    },
    { type: "text", text: OCR_PROMPT },
  ]);
}
