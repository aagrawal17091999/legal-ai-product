/**
 * Translation assembly step (runs in the cron worker, NOT off the upload request).
 *
 * The vision work (OCR + translate + structure, one call per page-range batch) is
 * done by the durable queue (job_batches). Once every batch for a job is `done`,
 * the worker wins the assembly CAS (status → 'assembling') and calls
 * `assembleTranslationJob(jobId)`: read the per-batch results in reading order,
 * assemble the block model, render the structured .docx, store it in R2, mark the
 * job ready, and mirror the status to Firestore for an instant client push.
 */

import pool from "../db";
import { uploadToR2 } from "../r2";
import { assembleTranslationResult } from "./translate";
import { renderBlocksDocx } from "./docx";
import { getJobBatches } from "../jobs/batches";
import { sourceKind } from "../vision/structured";
import { mirrorJobStatus } from "../firebase-admin";
import { logError } from "../error-logger";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function assembleTranslationJob(jobId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, user_id, source_filename, source_mime, target_language, status
       FROM translation_jobs WHERE id = $1`,
    [jobId]
  );
  if (rows.length === 0) return;
  const job = rows[0];
  if (job.status === "ready") return;

  try {
    const batches = await getJobBatches(jobId);
    const kind = sourceKind(job.source_mime, job.source_filename);
    const translation = assembleTranslationResult(
      batches.map((b) => b.result_json),
      kind,
      job.target_language
    );

    // Guard against shipping a blank "success": if the translator could not
    // render any segment with confidence (every segment flagged, or nothing was
    // translated at all), fail the job with a clear message instead of producing
    // an empty .docx marked ready.
    const segments = translation.segments;
    const anyUsableTranslation = segments.some(
      (s) => !s.flagged && s.translation.trim().length > 0
    );
    if (segments.length === 0 || !anyUsableTranslation) {
      throw new Error(
        "Couldn't read this document — it looks like a low-quality scan, so no " +
          "section could be translated with confidence. Try a clearer copy or a " +
          "text-based PDF."
      );
    }

    const docxBuffer = await renderBlocksDocx(translation);

    const baseName = job.source_filename.replace(/\.[^.]+$/, "").replace(/[^\w.\-]+/g, "_").slice(-100);
    const outKey = `translations/${job.user_id}/${jobId}-${baseName}.docx`;
    await uploadToR2(outKey, docxBuffer, DOCX_MIME);

    await pool.query(
      `UPDATE translation_jobs
          SET status = 'ready', output_r2_key = $2, detected_language = $3,
              segment_count = $4, flagged_count = $5, ocr_used = $6,
              result_json = $7, error = NULL, updated_at = NOW()
        WHERE id = $1`,
      [
        jobId,
        outKey,
        translation.detectedLanguage,
        translation.segments.length,
        translation.flaggedCount,
        translation.ocrUsed,
        JSON.stringify(translation),
      ]
    );
    await mirrorJobStatus("translate", jobId, { status: "ready" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE translation_jobs SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [jobId, message]
    );
    await mirrorJobStatus("translate", jobId, { status: "failed", error: message });
    logError({
      category: "extraction",
      message: `Translation assembly failed: ${message}`,
      error: err,
      severity: "error",
      metadata: { feature: "translate_assemble", jobId },
    });
  }
}
