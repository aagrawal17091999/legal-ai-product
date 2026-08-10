/**
 * Sarvam stages for OCR + Translation: reading, then translating.
 *
 * Reading a page, translating it and structuring it used to be ONE Claude vision
 * call. Sarvam now does the first two — Doc AI reads the pixels (₹0.50/page) and
 * /translate translates the text — leaving Claude one job: turning prose into the
 * typed block model, which is what preserves the `flagged` illegible-span
 * markers, citation italics and kv/partyLabel/signature typing that Sarvam's
 * Markdown cannot express. Because Claude no longer reads OR translates, that
 * step runs on Haiku (see the model selection in ocr.ts / translate.ts).
 *
 * Three background steps, run by the cron worker each tick:
 *
 *   submitSarvamOcrBatches()  ocr_pending     → ocr_submitted    (10 req/min cap)
 *   pollSarvamOcrBatches()    ocr_submitted   → xlate_pending    (translation jobs)
 *                                             → pending|planned  (OCR jobs)
 *   runSarvamTranslations()   xlate_pending   → pending|planned  (text translated)
 *
 * Each stage degrades independently and never fails a user's job:
 *   - read fails/402/stalls    → fallbackToVision(): Claude reads the pixels
 *   - translate fails/undetected language → fallbackToClaudeTranslation():
 *     Claude translates while structuring, still working from Sarvam's read
 * So Sarvam can be down, or its wallet empty, and jobs still complete on the
 * original single-pass Claude behaviour.
 */

import { getR2Object } from "../r2";
import { extractPdfRange } from "../vision/structured";
import {
  claimSarvamSubmissions,
  markSarvamSubmitted,
  findSarvamInFlight,
  completeSarvamOcr,
  fallbackToVision,
  requeueSarvamUnits,
  claimXlateBatches,
  completeXlate,
  fallbackToClaudeTranslation,
  requeueXlateUnits,
  getJobSource,
  type BatchRow,
  type JobSource,
} from "./batches";
import {
  submitDigitise,
  getJobStatus,
  getDigitiseText,
  identifyLanguage,
  translatePageText,
  isTerminal,
  SarvamOutOfCreditsError,
  SarvamRateLimitError,
  SARVAM_RATE_LIMIT_PER_MIN,
} from "../sarvam/client";
import { languageCode } from "../sarvam/languages";
import { withMeter, addSarvamUsage, addSarvamTranslateUsage } from "../billing/meter";
import { logError } from "../error-logger";

/** Units to submit per tick, before the 10 req/min window clamps it further. */
const SUBMIT_PER_TICK = Number(process.env.SARVAM_SUBMIT_PER_TICK) || SARVAM_RATE_LIMIT_PER_MIN;
/** In-flight units to poll per tick. Status polls don't count toward the cap the
 *  way submissions do, but keep it bounded so a tick can't run long. */
const POLL_PER_TICK = Number(process.env.SARVAM_POLL_PER_TICK) || 25;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A 402 means the Sarvam wallet is empty — every unit will fail identically until
 * someone tops it up, so shout loudly. The units themselves quietly fall back to
 * Claude, which is why this is a log and not a thrown error.
 */
function alertOutOfCredits(context: string): void {
  logError({
    category: "extraction",
    message:
      `Sarvam Doc AI is out of credits (${context}) — OCR is falling back to Claude ` +
      `vision at higher cost. Top up at dashboard.sarvam.ai/billing.`,
    severity: "critical",
    metadata: { feature: "sarvam_ocr" },
  });
}

/**
 * Submit claimed units to Sarvam. Claiming is itself rate-limited (see
 * claimSarvamSubmissions), so this never exceeds 10 requests/minute account-wide
 * no matter how many worker invocations overlap. Returns how many were submitted.
 */
export async function submitSarvamOcrBatches(): Promise<number> {
  const units = await claimSarvamSubmissions(SUBMIT_PER_TICK, SARVAM_RATE_LIMIT_PER_MIN);
  if (units.length === 0) return 0;

  // Cache per job: many units share one source document and one R2 read.
  const sources = new Map<string, JobSource | null>();
  const buffers = new Map<string, Buffer>();
  let submitted = 0;

  for (const unit of units) {
    try {
      if (!sources.has(unit.job_id)) {
        const src = await getJobSource(unit.job_kind, unit.job_id);
        sources.set(unit.job_id, src);
        if (src) buffers.set(unit.job_id, await getR2Object(src.source_r2_key));
      }
      const src = sources.get(unit.job_id);
      const buffer = buffers.get(unit.job_id);
      if (!src || !buffer) {
        await fallbackToVision([unit.id], "Job source unavailable for reading.");
        continue;
      }

      // A unit's page range is at most PAGES_PER_BATCH pages, which is pinned to
      // Sarvam's 10-page-per-job cap — so one unit is always one Sarvam job.
      const bytes =
        unit.page_start != null && unit.page_end != null
          ? await extractPdfRange(buffer, unit.page_start, unit.page_end)
          : buffer;

      const sarvamJobId = await submitDigitise(bytes, src.source_mime, src.source_filename);
      await markSarvamSubmitted(unit.id, sarvamJobId);
      submitted++;
    } catch (err) {
      if (err instanceof SarvamOutOfCreditsError) {
        alertOutOfCredits("submit");
        // No point trying the rest of this wave against an empty wallet.
        await fallbackToVision(
          units.slice(units.indexOf(unit)).map((u) => u.id),
          "Document reader unavailable; processing normally."
        );
        break;
      }
      if (err instanceof SarvamRateLimitError) {
        // We over-estimated our share of the 10/min budget. Put the unit back on
        // the Sarvam queue for the next tick — falling back to the pricier Claude
        // read over a transient throttle would be the wrong trade.
        await requeueSarvamUnits([unit.id]);
        continue;
      }
      logError({
        category: "extraction",
        message: `Sarvam submit failed for unit ${unit.id}: ${describe(err)}`,
        error: err,
        severity: "warning",
        metadata: { feature: "sarvam_ocr_submit", jobId: unit.job_id },
      });
      await fallbackToVision([unit.id], "Document reader failed; processing normally.");
    }
  }

  return submitted;
}

/** Meter a completed Sarvam read against the job owner's wallet (₹0.50/page). */
async function meterSarvamRead(
  userId: number,
  unit: BatchRow,
  pages: number
): Promise<void> {
  await withMeter(
    {
      userId,
      feature: unit.job_kind === "ocr" ? "ocr" : "translate",
      refId: unit.job_id,
    },
    async () => {
      addSarvamUsage(pages);
    }
  );
}

/**
 * Poll in-flight Sarvam jobs. Completed ones get their text stored and move to the
 * Claude phase; anything else falls back to vision. Returns per-outcome counts.
 */
export async function pollSarvamOcrBatches(): Promise<{ done: number; fellBack: number }> {
  const units = await findSarvamInFlight(POLL_PER_TICK);
  let done = 0;
  let fellBack = 0;

  // Cache job owners for metering — units of one job share an owner.
  const owners = new Map<string, number | null>();

  for (const unit of units) {
    const sarvamJobId = unit.sarvam_job_id;
    if (!sarvamJobId) continue;

    try {
      const status = await getJobStatus(sarvamJobId);
      if (!isTerminal(status.status)) continue; // still running — next tick

      if (status.status === "failed" || status.status === "rejected") {
        await fallbackToVision([unit.id], `Reader could not process these pages (${status.status}).`);
        fellBack++;
        continue;
      }

      // `completed` or `partially_completed`. Partial is still useful — Claude
      // flags whatever is missing rather than us discarding good pages.
      const { text, pages } = await getDigitiseText(sarvamJobId);
      if (!text.trim() || pages === 0) {
        await fallbackToVision([unit.id], "Reader returned no text; processing normally.");
        fellBack++;
        continue;
      }

      // Meter ONLY if this call won the transition. Overlapping cron invocations
      // can poll the same unit; without the guard each would charge for the read.
      if (!(await completeSarvamOcr(unit.id, text, pages))) continue;
      done++;

      if (!owners.has(unit.job_id)) {
        const src = await getJobSource(unit.job_kind, unit.job_id);
        owners.set(unit.job_id, src?.user_id ?? null);
      }
      const userId = owners.get(unit.job_id);
      if (userId) await meterSarvamRead(userId, unit, pages);
    } catch (err) {
      if (err instanceof SarvamOutOfCreditsError) {
        alertOutOfCredits("poll");
        await fallbackToVision([unit.id], "Document reader unavailable; processing normally.");
        fellBack++;
        continue;
      }
      if (err instanceof SarvamRateLimitError) continue; // leave in flight, retry next tick
      logError({
        category: "extraction",
        message: `Sarvam poll failed for unit ${unit.id}: ${describe(err)}`,
        error: err,
        severity: "warning",
        metadata: { feature: "sarvam_ocr_poll", jobId: unit.job_id, sarvamJobId },
      });
      // Leave it in flight; revertStuckSarvamUnits() is the backstop if it never
      // recovers, so a transient network blip doesn't cost us the cheap read.
    }
  }

  return { done, fellBack };
}

/**
 * Units translated per tick.
 *
 * A 10-page unit is ~2,300 chars/page ÷ 1,800 chars/request ≈ 15-20 /translate
 * calls, and the endpoint allows 60/min. Only the dispatcher runs this step (so
 * peer lanes don't multiply it) and the cron fires once a minute, which puts 3
 * units/tick at roughly 45-60 calls/min — at the limit without exceeding it.
 * Raise it only alongside a higher Sarvam plan.
 */
const XLATE_UNITS_PER_TICK = Number(process.env.SARVAM_XLATE_UNITS_PER_TICK) || 3;

/** Meter one unit's Sarvam translation (₹20/10K chars) against the job owner. */
async function meterTranslation(
  userId: number,
  unit: BatchRow,
  chars: number
): Promise<void> {
  await withMeter(
    { userId, feature: "translate", refId: unit.job_id },
    async () => {
      addSarvamTranslateUsage(chars);
    }
  );
}

/**
 * Translate claimed units with Sarvam, then hand them to Claude for structuring.
 *
 * The source language is detected per unit via /text-lid, because
 * sarvam-translate:v1 requires an explicit source (only mayura:v1 accepts
 * "auto"). /text-lid covers 11 languages while /translate covers 23, so an
 * undetectable source — Urdu, Assamese, Santali — falls back to Claude
 * translating, which it does perfectly well.
 */
export async function runSarvamTranslations(): Promise<{ done: number; fellBack: number }> {
  const units = await claimXlateBatches(XLATE_UNITS_PER_TICK);
  let done = 0;
  let fellBack = 0;

  const owners = new Map<string, { userId: number; target: string | null } | null>();

  for (const unit of units) {
    const sourceText = unit.ocr_text?.trim();
    if (!sourceText) {
      // Nothing was read — shouldn't happen (this stage is only reached after a
      // successful read), but never strand the unit.
      await fallbackToClaudeTranslation([unit.id], "No text to translate.");
      fellBack++;
      continue;
    }

    try {
      if (!owners.has(unit.job_id)) {
        const src = await getJobSource(unit.job_kind, unit.job_id);
        owners.set(
          unit.job_id,
          src ? { userId: src.user_id, target: src.target_language } : null
        );
      }
      const owner = owners.get(unit.job_id);
      const targetCode = owner?.target ? languageCode(owner.target) : null;
      if (!targetCode) {
        await fallbackToClaudeTranslation([unit.id], "Unsupported target language.");
        fellBack++;
        continue;
      }

      const sourceCode = await identifyLanguage(sourceText);
      if (!sourceCode) {
        await fallbackToClaudeTranslation([unit.id], "Source language not recognised.");
        fellBack++;
        continue;
      }

      // Already in the target language — nothing to translate, and paying to
      // "translate" hi-IN→hi-IN would be waste. Pass the text straight through.
      if (sourceCode === targetCode) {
        if (await completeXlate(unit.id, sourceText, sourceCode)) done++;
        continue;
      }

      const translated = await translatePageText(sourceText, sourceCode, targetCode);
      if (!translated.trim()) {
        await fallbackToClaudeTranslation([unit.id], "Translation returned no text.");
        fellBack++;
        continue;
      }

      // Meter only if this call won the transition, so a reclaimed lease can't
      // charge the same unit twice.
      if (!(await completeXlate(unit.id, translated, sourceCode))) continue;
      done++;
      if (owner) await meterTranslation(owner.userId, unit, sourceText.length);
    } catch (err) {
      if (err instanceof SarvamOutOfCreditsError) {
        alertOutOfCredits("translate");
        await fallbackToClaudeTranslation([unit.id], "Translation service unavailable.");
        fellBack++;
        continue;
      }
      if (err instanceof SarvamRateLimitError) {
        await requeueXlateUnits([unit.id], "Translation service busy; retrying.");
        continue;
      }
      logError({
        category: "extraction",
        message: `Sarvam translation failed for unit ${unit.id}: ${describe(err)}`,
        error: err,
        severity: "warning",
        metadata: { feature: "sarvam_translate", jobId: unit.job_id },
      });
      // Return it for another attempt; once xlate_attempts runs out,
      // revertExhaustedXlateUnits() hands it to Claude.
      await requeueXlateUnits([unit.id], "Translation failed; retrying.");
    }
  }

  return { done, fellBack };
}
