/**
 * OCR assembly step (runs in the cron worker, NOT off the upload request).
 *
 * The vision work is done batch-by-batch by the durable queue (job_batches);
 * once every batch for a job is `done`, the worker wins the assembly CAS
 * (status → 'assembling') and calls `assembleOcrJob(jobId)`. This reads the
 * per-batch results in reading order, assembles the block model, renders the PDF
 * (primary) + DOCX (editable), stores both in R2, marks the job ready, and
 * mirrors the status to Firestore so the client gets an instant push.
 */

import pool from "../db";
import { uploadToR2 } from "../r2";
import { renderBlocksDocx } from "../translate/docx";
import { assembleOcrResult } from "./ocr";
import { renderOcrPdf } from "./pdf";
import { getJobBatches } from "../jobs/batches";
import { sourceKind } from "../vision/structured";
import { mirrorJobStatus } from "../firebase-admin";
import { logError } from "../error-logger";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function assembleOcrJob(jobId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, user_id, source_filename, source_mime, status
       FROM ocr_jobs WHERE id = $1`,
    [jobId]
  );
  if (rows.length === 0) return;
  const job = rows[0];
  if (job.status === "ready") return;

  try {
    const batches = await getJobBatches(jobId);
    const kind = sourceKind(job.source_mime, job.source_filename);
    const result = assembleOcrResult(
      batches.map((b) => b.result_json),
      kind
    );

    // Guard against shipping a blank "success": if nothing could be read with
    // confidence (every segment flagged, or nothing transcribed), fail the job
    // with a clear message instead of producing an empty PDF marked ready.
    const segments = result.segments;
    const anyUsable = segments.some((s) => !s.flagged && s.translation.trim().length > 0);
    if (segments.length === 0 || !anyUsable) {
      throw new Error(
        "Couldn't read this document — it looks like a low-quality scan, so no " +
          "section could be transcribed with confidence. Try a clearer copy or a " +
          "text-based PDF."
      );
    }

    const [pdfBuffer, docxBuffer] = await Promise.all([
      renderOcrPdf(result),
      renderBlocksDocx(result),
    ]);

    const baseName = job.source_filename.replace(/\.[^.]+$/, "").replace(/[^\w.\-]+/g, "_").slice(-100);
    const pdfKey = `ocr/${job.user_id}/${jobId}-${baseName}.pdf`;
    const docxKey = `ocr/${job.user_id}/${jobId}-${baseName}.docx`;
    await Promise.all([
      uploadToR2(pdfKey, pdfBuffer, PDF_MIME),
      uploadToR2(docxKey, docxBuffer, DOCX_MIME),
    ]);

    await pool.query(
      `UPDATE ocr_jobs
          SET status = 'ready', output_pdf_r2_key = $2, output_docx_r2_key = $3,
              detected_language = $4, segment_count = $5, flagged_count = $6,
              ocr_used = $7, result_json = $8, error = NULL, updated_at = NOW()
        WHERE id = $1`,
      [
        jobId,
        pdfKey,
        docxKey,
        result.detectedLanguage,
        result.segments.length,
        result.flaggedCount,
        result.ocrUsed,
        JSON.stringify(result),
      ]
    );
    await mirrorJobStatus("ocr", jobId, { status: "ready" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE ocr_jobs SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [jobId, message]
    );
    await mirrorJobStatus("ocr", jobId, { status: "failed", error: message });
    logError({
      category: "extraction",
      message: `OCR assembly failed: ${message}`,
      error: err,
      severity: "error",
      metadata: { feature: "ocr_assemble", jobId },
    });
  }
}
