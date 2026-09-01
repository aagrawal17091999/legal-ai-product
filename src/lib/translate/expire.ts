/**
 * Per-user stuck-job watchdog for Translation (called from GET /api/translate).
 *
 * The durable queue + cron worker now own the normal failure path (batch retries
 * exhausted → job failed) and a global stale sweep. This per-user pass is a
 * belt-and-suspenders check on list load: any of the caller's jobs stuck
 * `processing`/`assembling` that has STOPPED MAKING PROGRESS is flipped to
 * `failed` and mirrored to Firestore, so the push-based UI stops spinning even
 * between cron ticks. The progress rule lives in failStalledJobs — this used to
 * fail jobs purely on age, which meant a user refreshing the list could kill
 * their own long-but-healthy document.
 */

import { failStalledJobs, STALE_JOB_MESSAGE } from "../jobs/batches";
import { mirrorJobStatus } from "../firebase-admin";

export async function expireStaleTranslations(userId: number): Promise<void> {
  const ids = await failStalledJobs("translate", { userId });
  for (const id of ids) {
    await mirrorJobStatus("translate", id, { status: "failed", error: STALE_JOB_MESSAGE });
  }
}
