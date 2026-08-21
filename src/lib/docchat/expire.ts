/**
 * Stuck-document watchdog for the Document Workspace (Feature 1).
 *
 * Ingestion runs in `after()` on the request that uploaded the file, so it dies
 * with the process: a deploy, a pm2 restart, or an OOM mid-embed leaves the row
 * on `pending`/`processing` with nobody left to settle it. Translation and OCR
 * already have this belt-and-suspenders pass (lib/translate/expire.ts,
 * lib/ocr/expire.ts) because their workers can die the same way; workspace
 * documents had none, so a killed ingestion showed "Processing" forever and the
 * failure was never recorded anywhere the user could see.
 *
 * Called on every read of a workspace's documents, so the very poll that was
 * spinning on "Processing" is the one that returns the terminal `failed` state.
 */

import pool from "../db";
import { logError } from "../error-logger";

/**
 * How long a document may sit un-settled before we call it dead. The upload
 * route caps ingestion at `maxDuration = 300`s; this leaves generous headroom
 * over that so a genuinely slow multi-page OCR is never failed out from under
 * itself.
 */
export const STALE_DOCUMENT_TIMEOUT_MS = 15 * 60 * 1000;

export const STALE_DOCUMENT_MESSAGE =
  "Processing stopped unexpectedly and did not finish. Please delete this document and upload it again.";

/**
 * Flip any of this workspace's documents stuck `pending`/`processing` past the
 * timeout to `failed`, recording why. Best-effort: a failure here must never
 * break the read that called it.
 */
export async function expireStaleDocuments(workspaceId: string): Promise<void> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE workspace_documents
          SET status = 'failed', error = $2, updated_at = NOW()
        WHERE workspace_id = $1
          AND status IN ('pending', 'processing')
          AND created_at < NOW() - ($3 * INTERVAL '1 millisecond')
        RETURNING id`,
      [workspaceId, STALE_DOCUMENT_MESSAGE, STALE_DOCUMENT_TIMEOUT_MS]
    );
    for (const r of rows) {
      logError({
        category: "extraction",
        message: "Document ingestion never settled; expired by the watchdog",
        severity: "error",
        metadata: {
          feature: "docchat_ingest",
          documentId: r.id,
          workspaceId,
          timeout_ms: STALE_DOCUMENT_TIMEOUT_MS,
        },
      });
    }
  } catch (err) {
    logError({
      category: "database",
      message: `stale-document sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { workspaceId },
    });
  }
}
