/**
 * Durable per-batch work queue shared by OCR and Translation (table: job_batches,
 * migration 022). A job is split into page-range batches at upload; the cron
 * worker (/api/cron/process-batches) claims pending rows with FOR UPDATE SKIP
 * LOCKED — so concurrent workers and many simultaneous users never double-process
 * — runs one vision call per batch (each in its own function invocation, with a
 * fresh 300s budget), and assembles the job once every batch is done.
 *
 * This module owns all queue SQL so the upload routes, the worker, and the
 * assembly functions share one definition.
 */

import pool from "../db";
import type { BatchPlanItem, ParsedBatch } from "../vision/structured";

export type JobKind = "ocr" | "translate";

/** How a unit is processed: a live vision call in the worker, or the Batch API. */
export type Delivery = "sync" | "batch";

/**
 * Statuses meaning a unit is not yet terminally settled — `done`/`failed` are
 * terminal, everything else is outstanding. Includes the Batch-API lifecycle
 * (planned/submitting/submitted) so a job mid-flight on the Anthropic Batch API
 * is neither prematurely assembled nor failed by the completion check.
 */
const OUTSTANDING_SQL = "('pending', 'processing', 'planned', 'submitting', 'submitted')";

/**
 * The Batch-API-only in-flight statuses. A job with units in any of these is
 * legitimately waiting on Anthropic (up to the 24h batch window) and must be
 * exempt from the 30-minute stale-job watchdog — its natural bound is the
 * batch's own expiry, after which expired units fall back to the sync path.
 */
const BATCH_INFLIGHT_SQL = "('planned', 'submitting', 'submitted')";

/** Give a batch this many tries before it's marked permanently failed. */
export const MAX_BATCH_ATTEMPTS = 3;

/**
 * Lease length for a claimed batch. A worker invocation is killed at 300s, so a
 * batch still `processing` past this is presumed abandoned (worker crash, deploy,
 * timeout) and may be re-claimed. Must exceed maxDuration with margin so a slow-
 * but-alive wave isn't stolen out from under a live worker.
 */
export const BATCH_LEASE_MS = 6 * 60 * 1000;

/**
 * How long a job may sit unfinished before the watchdog fails it. Raised well
 * above the old 10-minute single-shot timeout: under concurrent load a large
 * document legitimately waits in the queue and drains across many cron ticks.
 */
export const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Hard ceiling for a unit sitting `submitted` on the Anthropic Batch API. The
 * batch window is "usually < 1h, max 24h"; past this we assume the batch is lost
 * and revert the unit to the synchronous path so the job can never hang forever.
 */
export const BATCH_API_MAX_AGE_MS = 25 * 60 * 60 * 1000;

export const STALE_JOB_MESSAGE =
  "This document took too long to process — it may be very large or the service " +
  "was under heavy load. Please try again.";

export interface BatchRow {
  id: string;
  job_id: string;
  job_kind: JobKind;
  batch_index: number;
  page_start: number | null;
  page_end: number | null;
  status: "pending" | "processing" | "planned" | "submitting" | "submitted" | "done" | "failed";
  delivery: Delivery;
  provider_batch_id: string | null;
  attempts: number;
  result_json: ParsedBatch;
  error: string | null;
}

/** Source info needed to (re)build a job's vision requests, used by the worker
 *  and the Batch-API submitter. */
export interface JobSource {
  user_id: number;
  source_r2_key: string;
  source_mime: string;
  source_filename: string;
  target_language: string | null;
}

/** Fetch the parent job's source info needed to run/submit its batches. */
export async function getJobSource(kind: JobKind, jobId: string): Promise<JobSource | null> {
  const cols =
    kind === "translate"
      ? "user_id, source_r2_key, source_mime, source_filename, target_language"
      : "user_id, source_r2_key, source_mime, source_filename, NULL AS target_language";
  const { rows } = await pool.query<JobSource>(
    `SELECT ${cols} FROM ${jobTable(kind)} WHERE id = $1`,
    [jobId]
  );
  return rows[0] ?? null;
}

/** Postgres table holding the parent job rows for a kind. */
export function jobTable(kind: JobKind): string {
  return kind === "ocr" ? "ocr_jobs" : "translation_jobs";
}

/**
 * Insert one row per planned batch. `delivery` decides the starting status and
 * therefore which worker picks the unit up: `sync` units start `pending` (the
 * synchronous vision worker claims them); `batch` units start `planned` (the
 * Batch-API submitter claims them, see jobs/batch-api.ts).
 */
export async function enqueueBatches(
  jobId: string,
  jobKind: JobKind,
  items: BatchPlanItem[],
  delivery: Delivery = "sync"
): Promise<void> {
  if (items.length === 0) return;
  const status = delivery === "batch" ? "planned" : "pending";
  const values: string[] = [];
  const params: unknown[] = [];
  items.forEach((b, i) => {
    const o = i * 7;
    values.push(
      `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`
    );
    params.push(jobId, jobKind, b.index, b.pageStart, b.pageEnd, status, delivery);
  });
  await pool.query(
    `INSERT INTO job_batches
       (job_id, job_kind, batch_index, page_start, page_end, status, delivery)
     VALUES ${values.join(", ")}`,
    params
  );
}

/**
 * Atomically claim up to `limit` runnable batches. FOR UPDATE SKIP LOCKED lets
 * many concurrent workers grab disjoint rows with no contention; ordering by
 * created_at drains older jobs first (FIFO fairness across jobs).
 *
 * Runnable = `pending`, OR `processing` whose lease expired (the worker that held
 * it died — see BATCH_LEASE_MS). The lease reclaim is what makes the queue
 * self-healing: a crashed/timed-out worker's batches return to circulation
 * instead of stranding the whole job until the 30-minute job sweep.
 */
export async function claimPendingBatches(limit: number): Promise<BatchRow[]> {
  const { rows } = await pool.query<BatchRow>(
    `WITH c AS (
       SELECT id FROM job_batches
        WHERE status = 'pending'
           OR (status = 'processing' AND locked_at < NOW() - ($2 * INTERVAL '1 millisecond'))
        ORDER BY created_at, batch_index
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE job_batches b
        SET status = 'processing', locked_at = NOW(), attempts = attempts + 1,
            updated_at = NOW()
       FROM c WHERE b.id = c.id
     RETURNING b.*`,
    [limit, BATCH_LEASE_MS]
  );
  return rows;
}

/** Mark a batch done and store its parsed vision result. */
export async function completeBatch(id: string, result: ParsedBatch): Promise<void> {
  await pool.query(
    `UPDATE job_batches
        SET status = 'done', result_json = $2, error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [id, JSON.stringify(result)]
  );
}

/**
 * Record a failed attempt. If the batch still has retries left, return it to
 * `pending` so the next cron tick re-claims it; otherwise mark it permanently
 * `failed` (which will fail the parent job during the completion check).
 */
export async function recordBatchFailure(
  id: string,
  attempts: number,
  error: string
): Promise<void> {
  const terminal = attempts >= MAX_BATCH_ATTEMPTS;
  await pool.query(
    `UPDATE job_batches
        SET status = $2, error = $3, updated_at = NOW()
      WHERE id = $1`,
    [id, terminal ? "failed" : "pending", error]
  );
}

/** All batches for a job in reading order — used to assemble the final result. */
export async function getJobBatches(jobId: string): Promise<BatchRow[]> {
  const { rows } = await pool.query<BatchRow>(
    `SELECT * FROM job_batches WHERE job_id = $1 ORDER BY batch_index`,
    [jobId]
  );
  return rows;
}

export interface JobBatchState {
  total: number;
  outstanding: number; // pending or processing
  failed: number;
  done: number;
}

export async function jobBatchState(jobId: string): Promise<JobBatchState> {
  const { rows } = await pool.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::int AS n FROM job_batches WHERE job_id = $1 GROUP BY status`,
    [jobId]
  );
  const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  const done = by("done");
  const failed = by("failed");
  return {
    total,
    // Everything that isn't terminally done/failed is still outstanding — this
    // covers the Batch-API in-flight statuses without enumerating them.
    outstanding: total - done - failed,
    failed,
    done,
  };
}

/**
 * Find jobs ready to settle: parent still `processing`, has batches, and none of
 * them are outstanding (all done/failed). Run every tick independent of what this
 * worker claimed, so a job whose final batch was finished by another invocation
 * (or whose completing worker crashed before settling) still gets assembled —
 * rather than waiting for the 30-minute sweep to wrongly fail a successful job.
 */
export async function findSettleableJobs(kind: JobKind, limit = 50): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT j.id FROM ${jobTable(kind)} j
      WHERE j.status = 'processing'
        AND EXISTS (SELECT 1 FROM job_batches b WHERE b.job_id = j.id)
        AND NOT EXISTS (
          SELECT 1 FROM job_batches b
           WHERE b.job_id = j.id AND b.status IN ${OUTSTANDING_SQL}
        )
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.id);
}

/**
 * Try to win the right to assemble a job: atomically flip the parent row from
 * 'processing' to 'assembling', but only if no batch is still outstanding. Exactly
 * one concurrent worker wins (the UPDATE is atomic); the rest get rowCount 0 and
 * skip assembly. Returns true for the winner.
 */
export async function tryAcquireAssembly(kind: JobKind, jobId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE ${jobTable(kind)}
        SET status = 'assembling', updated_at = NOW()
      WHERE id = $1 AND status = 'processing'
        AND NOT EXISTS (
          SELECT 1 FROM job_batches
           WHERE job_id = $1 AND status IN ${OUTSTANDING_SQL}
        )`,
    [jobId]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Mark the parent job failed (when one of its batches exhausted its retries).
 * CAS from 'processing' so it doesn't fight an assembly already in flight or a
 * watchdog that already failed it. Returns true if this call flipped it.
 */
export async function failJob(kind: JobKind, jobId: string, message: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE ${jobTable(kind)}
        SET status = 'failed', error = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'processing'`,
    [jobId, message]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Queue backlog snapshot for observability: how many batches are waiting and how
 * old the oldest one is. The worker logs this each tick so growing backlog / age
 * is visible (the signal to raise worker concurrency or add lanes).
 */
export async function queueDepth(): Promise<{ pending: number; oldestCreatedAt: Date | null }> {
  const { rows } = await pool.query<{ pending: number; oldest: Date | null }>(
    `SELECT COUNT(*)::int AS pending, MIN(created_at) AS oldest
       FROM job_batches WHERE status = 'pending'`
  );
  return { pending: rows[0]?.pending ?? 0, oldestCreatedAt: rows[0]?.oldest ?? null };
}

/**
 * Global watchdog: fail any job stuck `processing`/`assembling` past the timeout,
 * across all users. Run by the cron worker every tick so recovery doesn't depend
 * on a client hitting the list endpoint (the UI is now push-based). Returns the
 * ids that were flipped so the caller can mirror them to Firestore.
 */
export async function sweepStaleJobs(
  kind: JobKind,
  timeoutMs: number = STALE_JOB_TIMEOUT_MS
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE ${jobTable(kind)} j
        SET status = 'failed', error = $1, updated_at = NOW()
      WHERE j.status IN ('processing', 'assembling')
        AND j.created_at < NOW() - ($2 * INTERVAL '1 millisecond')
        -- Exempt jobs still legitimately in flight on the Batch API; their bound
        -- is the 24h batch window, after which expired units fall back to sync.
        AND NOT EXISTS (
          SELECT 1 FROM job_batches b
           WHERE b.job_id = j.id AND b.status IN ${BATCH_INFLIGHT_SQL}
        )
      RETURNING j.id`,
    [STALE_JOB_MESSAGE, timeoutMs]
  );
  return rows.map((r) => r.id);
}

// ── Batch-API delivery (jobs/batch-api.ts) ───────────────────────────────────
// Large jobs are submitted to the Anthropic Message Batch API instead of being
// run as live vision calls. Units flow planned → submitting → submitted → done,
// with submit/expiry failures falling back to the sync path (status → pending).

/** Jobs of `kind` with units still waiting to be submitted to the Batch API. */
export async function findPlannedJobs(kind: JobKind, limit = 10): Promise<string[]> {
  const { rows } = await pool.query<{ job_id: string }>(
    `SELECT DISTINCT job_id FROM job_batches
      WHERE job_kind = $1 AND status = 'planned'
      LIMIT $2`,
    [kind, limit]
  );
  return rows.map((r) => r.job_id);
}

/**
 * Atomically claim a job's planned units for submission: flip them planned →
 * submitting and return them. Empty result means another worker already claimed
 * this job (the UPDATE is the lock), so the caller should skip it.
 */
export async function claimJobForSubmission(jobId: string): Promise<BatchRow[]> {
  const { rows } = await pool.query<BatchRow>(
    `UPDATE job_batches
        SET status = 'submitting', updated_at = NOW()
      WHERE job_id = $1 AND delivery = 'batch' AND status = 'planned'
      RETURNING *`,
    [jobId]
  );
  return rows;
}

/** Mark a job's units submitted and stamp the Anthropic batch id on them. */
export async function markBatchSubmitted(
  unitIds: string[],
  providerBatchId: string
): Promise<void> {
  if (unitIds.length === 0) return;
  await pool.query(
    `UPDATE job_batches
        SET status = 'submitted', provider_batch_id = $2, updated_at = NOW()
      WHERE id = ANY($1::uuid[])`,
    [unitIds, providerBatchId]
  );
}

/**
 * Fall back to the synchronous path. Used when batch submission fails or a batch
 * result is unusable/expired: the units return to `pending` as `sync`, so the
 * vision worker processes them at full price rather than stranding the job.
 */
export async function revertUnitsToSync(unitIds: string[], error?: string): Promise<void> {
  if (unitIds.length === 0) return;
  await pool.query(
    `UPDATE job_batches
        SET status = 'pending', delivery = 'sync', provider_batch_id = NULL,
            error = $2, updated_at = NOW()
      WHERE id = ANY($1::uuid[])`,
    [unitIds, error ?? null]
  );
}

/** Distinct Anthropic batch ids with units still awaiting their results. */
export async function findInFlightProviderBatches(limit = 25): Promise<string[]> {
  const { rows } = await pool.query<{ provider_batch_id: string }>(
    `SELECT DISTINCT provider_batch_id FROM job_batches
      WHERE status = 'submitted' AND provider_batch_id IS NOT NULL
      LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.provider_batch_id);
}

/** The still-submitted units of one Anthropic batch, for result routing + metering. */
export async function getProviderBatchUnits(
  providerBatchId: string
): Promise<{ id: string; job_id: string; job_kind: JobKind }[]> {
  const { rows } = await pool.query<{ id: string; job_id: string; job_kind: JobKind }>(
    `SELECT id, job_id, job_kind FROM job_batches
      WHERE provider_batch_id = $1 AND status = 'submitted'`,
    [providerBatchId]
  );
  return rows;
}

/**
 * Store a Batch-API result and mark the unit done (guarded to the submitted
 * state). Returns true only if THIS call flipped the row from submitted → done.
 * Concurrent worker invocations overlap (the cron drains for ~210s but fires
 * every 60s), so two pollers can stream the same ended batch's results; the
 * guard makes exactly one of them win. Callers meter only on a true return so a
 * unit is billed exactly once.
 */
export async function completeSubmittedBatch(id: string, result: ParsedBatch): Promise<boolean> {
  const res = await pool.query(
    `UPDATE job_batches
        SET status = 'done', result_json = $2, error = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'submitted'`,
    [id, JSON.stringify(result)]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Dead-man's switch for the Batch API. A unit left `submitted` longer than
 * maxAgeMs means its Anthropic batch never reached `ended` (lost batch, or a
 * backlog beyond the poll LIMIT so it was never polled) — and such units are
 * EXEMPT from the stale-job watchdog, so without this the parent job would spin
 * forever. Revert them to the synchronous path so the job still completes (or
 * fails cleanly). Returns the affected job ids so the caller can settle/sweep.
 */
export async function revertExpiredBatchUnits(
  maxAgeMs: number = BATCH_API_MAX_AGE_MS
): Promise<string[]> {
  const { rows } = await pool.query<{ job_id: string }>(
    `UPDATE job_batches
        SET status = 'pending', delivery = 'sync', provider_batch_id = NULL,
            error = 'Batch API did not complete in time; processing normally.',
            updated_at = NOW()
      WHERE status = 'submitted'
        AND updated_at < NOW() - ($1 * INTERVAL '1 millisecond')
      RETURNING job_id`,
    [maxAgeMs]
  );
  return [...new Set(rows.map((r) => r.job_id))];
}
