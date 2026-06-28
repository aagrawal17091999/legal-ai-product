/**
 * Per-user stuck-job watchdog for Translation (called from GET /api/translate).
 *
 * The durable queue + cron worker now own the normal failure path (batch retries
 * exhausted → job failed) and a global stale sweep. This per-user pass is a
 * belt-and-suspenders check on list load: any of the caller's jobs stuck
 * `processing`/`assembling` past the timeout is flipped to `failed` and mirrored
 * to Firestore so the push-based UI stops spinning even between cron ticks.
 */

import pool from "../db";
import { STALE_JOB_TIMEOUT_MS, STALE_JOB_MESSAGE } from "../jobs/batches";
import { mirrorJobStatus } from "../firebase-admin";

export async function expireStaleTranslations(userId: number): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE translation_jobs
        SET status = 'failed', error = $2, updated_at = NOW()
      WHERE user_id = $1
        AND status IN ('processing', 'assembling')
        AND created_at < NOW() - ($3 * INTERVAL '1 millisecond')
      RETURNING id`,
    [userId, STALE_JOB_MESSAGE, STALE_JOB_TIMEOUT_MS]
  );
  for (const r of rows) {
    await mirrorJobStatus("translate", r.id, { status: "failed", error: STALE_JOB_MESSAGE });
  }
}
