/**
 * HTML → PDF via headless Chromium.
 *
 * We render the OCR block model to HTML (./html.ts) and print it with
 * @sparticuz/chromium + puppeteer-core. Chromium is the only engine that shapes
 * Devanagari/Indic conjuncts correctly — pdf-lib would lay glyphs out by raw
 * codepoint and mangle every Hindi/Gujarati matra.
 *
 * Indic fonts are absent from the headless build, so the HTML declares the Noto
 * fonts it needs via @font-face (./html.ts) pointing at the Noto TTFs on a CDN.
 * Chromium fetches each only when a glyph uses it; we wait for
 * document.fonts.ready before printing so nothing renders as tofu.
 *
 * On Vercel the Lambda Chromium binary is used; locally we fall back to an
 * installed Chrome (PUPPETEER_EXECUTABLE_PATH, or the default macOS path).
 */

import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser } from "puppeteer-core";
import { renderOcrHtml } from "./html";
import type { OcrResult } from "./ocr";

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

const LOCAL_CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function launch(): Promise<Browser> {
  if (isServerless) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  return puppeteer.launch({ executablePath: LOCAL_CHROME, headless: true });
}

export async function renderOcrPdf(result: OcrResult): Promise<Buffer> {
  const { html } = renderOcrHtml(result);

  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // @font-face fonts load lazily during layout — make sure they've finished
    // (and give a hard cap so a slow CDN can't hang the function) before print.
    await Promise.race([
      page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready),
      new Promise((r) => setTimeout(r, 15000)),
    ]);
    const pdf = await page.pdf({
      format: "a4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
