/**
 * Stuck-job watchdog (Feature 2).
 *
 * Translation runs in an `after()` background task. If that task is killed —
 * the function hits its time limit, the process crashes, or a dev-server hot
 * reload tears it down — the job row is left `processing` forever and the UI
 * spins indefinitely. There is no callback on a killed task to mark it failed.
 *
 * As a cheap backstop, the status/list endpoints sweep the caller's own jobs on
 * read: any job still `processing` past the timeout below is treated as dead and
 * flipped to `failed`. The function limit is 300s, so 10 minutes is well clear of
 * any legitimately-running job.
 */

import pool from "../db";

export const TRANSLATION_TIMEOUT_MS = 10 * 60 * 1000;

const TIMEOUT_MESSAGE =
  "Translation timed out before it finished — this can happen with large or " +
  "heavily-scanned documents. Please try again.";

/** Mark the user's stale `processing` jobs as failed so the UI stops spinning. */
export async function expireStaleTranslations(userId: number): Promise<void> {
  await pool.query(
    `UPDATE translation_jobs
        SET status = 'failed', error = $2, updated_at = NOW()
      WHERE user_id = $1
        AND status = 'processing'
        AND created_at < NOW() - ($3 * INTERVAL '1 millisecond')`,
    [userId, TIMEOUT_MESSAGE, TRANSLATION_TIMEOUT_MS]
  );
}
