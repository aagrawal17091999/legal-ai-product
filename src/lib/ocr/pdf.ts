/**
 * HTML → PDF via headless Chromium.
 *
 * We render the shared block model — OCR results and translations alike — to
 * HTML (./html.ts) and print it with
 * @sparticuz/chromium + puppeteer-core. Chromium is the only engine that shapes
 * Devanagari/Indic conjuncts correctly — pdf-lib would lay glyphs out by raw
 * codepoint and mangle every Hindi/Gujarati matra.
 *
 * Indic fonts are absent from the headless build, so the HTML declares the Noto
 * fonts it needs via @font-face (./html.ts) pointing at the Noto TTFs on a CDN.
 * Chromium fetches each only when a glyph uses it; we wait for
 * document.fonts.ready before printing so nothing renders as tofu.
 *
 * Choosing the binary: on a serverless host the bundled Lambda Chromium is used;
 * everywhere else we launch an installed Chrome/Chromium from
 * PUPPETEER_EXECUTABLE_PATH, falling back to the usual Linux and macOS paths.
 *
 * The Linux path matters: this app now runs on a plain Ubuntu box, not Vercel,
 * so the serverless branch never fires in production. Before this was handled,
 * launch() fell through to a hardcoded macOS Chrome path and every OCR job
 * failed at the render step with "Browser was not found".
 */

import { existsSync } from "node:fs";
import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser } from "puppeteer-core";
import { renderBlocksHtml, type BlockDocument } from "./html";

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME_CANDIDATES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
];

function localChrome(): string {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  if (process.platform === "darwin") return MACOS_CHROME;
  return LINUX_CHROME_CANDIDATES.find((p) => existsSync(p)) ?? MACOS_CHROME;
}

/**
 * Chromium refuses to start as root without --no-sandbox, and the app runs as
 * root under pm2 on the box — without this every OCR render dies at launch.
 * --disable-dev-shm-usage keeps it off the small default /dev/shm, which
 * otherwise makes Chromium crash part-way through printing a long document.
 */
const LINUX_LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];

async function launch(): Promise<Browser> {
  if (isServerless) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  return puppeteer.launch({
    executablePath: localChrome(),
    headless: true,
    ...(process.platform === "linux" ? { args: LINUX_LAUNCH_ARGS } : {}),
  });
}

export async function renderBlocksPdf(result: BlockDocument): Promise<Buffer> {
  const { html } = renderBlocksHtml(result);

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
