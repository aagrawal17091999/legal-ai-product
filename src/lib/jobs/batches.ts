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
 * is neither prematurely assembled nor failed by the completion check, and the
 * Sarvam OCR-read lifecycle (ocr_pending/ocr_submitted) for the same reason.
 */
const OUTSTANDING_SQL =
  "('ocr_pending', 'ocr_submitted', 'xlate_pending', 'xlate_processing', " +
  "'pending', 'processing', 'planned', 'submitting', 'submitted')";

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
  status:
    | "ocr_pending"
    | "ocr_submitted"
    | "xlate_pending"
    | "xlate_processing"
    | "pending"
    | "processing"
    | "planned"
    | "submitting"
    | "submitted"
    | "done"
    | "failed";
  delivery: Delivery;
  provider_batch_id: string | null;
  attempts: number;
  result_json: ParsedBatch;
  error: string | null;
  /** Markdown Sarvam extracted for this page range; null = send pixels to Claude. */
  ocr_text: string | null;
  sarvam_job_id: string | null;
  sarvam_pages: number | null;
  /** Reading attempts spent on Sarvam — separate from `attempts` (Claude's budget). */
  sarvam_attempts: number;
  /** Target-language text from Sarvam /translate; null = Claude translates too. */
  translated_text: string | null;
  /** Source language detected by Sarvam (BCP-47) — authoritative once the text
   *  handed to Claude is already translated. */
  source_language: string | null;
  xlate_attempts: number;
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
 * Insert one row per planned batch. The starting status decides which worker
 * picks the unit up:
 *   - `ocr_pending`  → the Sarvam submitter reads the pages first (jobs/sarvam-ocr.ts).
 *                      When Sarvam returns, the unit moves on to `pending`/`planned`.
 *   - `pending`      → the synchronous Claude worker claims it (delivery `sync`).
 *   - `planned`      → the Anthropic Batch-API submitter claims it (delivery `batch`).
 *
 * `delivery` is recorded either way, so a unit that goes through Sarvam first
 * still lands on the right Claude path afterwards.
 *
 * @param viaSarvam route this job's units through Sarvam Doc AI for the read
 *   step. Only true for PDF/image sources with the integration switched on — a
 *   DOCX has no pixels to read, and with Sarvam off every unit starts as before.
 */
export async function enqueueBatches(
  jobId: string,
  jobKind: JobKind,
  items: BatchPlanItem[],
  delivery: Delivery = "sync",
  viaSarvam = false
): Promise<void> {
  if (items.length === 0) return;
  const status = viaSarvam ? "ocr_pending" : delivery === "batch" ? "planned" : "pending";
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
    // Counts units waiting on the Sarvam read too — they are backlog just the
    // same, and at 10 Sarvam req/min they are the likelier place for it to build.
    `SELECT COUNT(*)::int AS pending, MIN(created_at) AS oldest
       FROM job_batches WHERE status IN ('pending', 'ocr_pending')`
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

// ── Sarvam Doc AI read step (jobs/sarvam-ocr.ts) ─────────────────────────────
// PDF/image units are read by Sarvam before Claude structures the text. Units
// flow ocr_pending → ocr_submitted → pending|planned, with every failure mode
// falling back to `pending` with ocr_text NULL — i.e. the original Claude vision
// path — so Sarvam is never a single point of failure for a user's job.

/**
 * How long a unit may sit `ocr_submitted` before we give up on Sarvam and read
 * it with Claude vision instead. Doc AI jobs are minutes at worst, so this is
 * generous; it exists so a lost Sarvam job can't wedge the parent job until the
 * 30-minute stale sweep kills it outright.
 */
export const SARVAM_MAX_INFLIGHT_MS =
  Number(process.env.SARVAM_MAX_INFLIGHT_MS) || 10 * 60 * 1000;

/**
 * How many times a unit may be sent to Sarvam before we give up and let Claude
 * read it. Counted separately from `attempts` (the Claude retry budget) so a
 * throttled read never leaves a unit with no retries left for the Claude phase.
 */
export const MAX_SARVAM_ATTEMPTS = Number(process.env.SARVAM_MAX_ATTEMPTS) || 3;

/**
 * Claim units to submit to Sarvam, respecting its 10 requests/minute cap.
 *
 * The cap is ACCOUNT-WIDE and identical on every plan tier, so it must hold
 * across overlapping cron invocations and fan-out lanes — a per-invocation
 * constant would not do it (the worker's 210s budget means 3-4 invocations run
 * concurrently). Instead the limit is clamped by a sliding-window count of
 * everything submitted in the last 60s, computed inside the same statement that
 * claims the rows. The window counts by `sarvam_submitted_at` regardless of
 * current status: a unit whose result already came back still spent a request.
 */
export async function claimSarvamSubmissions(
  limit: number,
  perMinute: number
): Promise<BatchRow[]> {
  const { rows } = await pool.query<BatchRow>(
    `WITH budget AS (
       SELECT GREATEST(
                0,
                LEAST(
                  $1::int,
                  $2::int - (SELECT COUNT(*) FROM job_batches
                              WHERE sarvam_submitted_at > NOW() - INTERVAL '60 seconds')
                )
              ) AS n
     ),
     c AS (
       SELECT id FROM job_batches
        WHERE status = 'ocr_pending' AND sarvam_attempts < $3
        ORDER BY created_at, batch_index
        LIMIT (SELECT n FROM budget)
        FOR UPDATE SKIP LOCKED
     )
     UPDATE job_batches b
        SET status = 'ocr_submitted', sarvam_submitted_at = NOW(),
            sarvam_attempts = b.sarvam_attempts + 1,
            locked_at = NOW(), updated_at = NOW()
       FROM c WHERE b.id = c.id
     RETURNING b.*`,
    [limit, perMinute, MAX_SARVAM_ATTEMPTS]
  );
  return rows;
}

/** Stamp the Sarvam job id on a unit we just submitted. */
export async function markSarvamSubmitted(id: string, sarvamJobId: string): Promise<void> {
  await pool.query(
    `UPDATE job_batches SET sarvam_job_id = $2, updated_at = NOW() WHERE id = $1`,
    [id, sarvamJobId]
  );
}

/** Units awaiting a Sarvam result, oldest first. */
export async function findSarvamInFlight(limit = 25): Promise<BatchRow[]> {
  const { rows } = await pool.query<BatchRow>(
    `SELECT * FROM job_batches
      WHERE status = 'ocr_submitted' AND sarvam_job_id IS NOT NULL
      ORDER BY sarvam_submitted_at
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Store Sarvam's extracted text and advance the unit to its next stage:
 *   - a TRANSLATION unit goes to `xlate_pending` so Sarvam can translate the text;
 *   - an OCR unit has nothing to translate, so it goes straight to the Claude
 *     structuring phase — `planned` on the Anthropic Batch API path, else `pending`.
 *
 * Guarded on `ocr_submitted` so two overlapping pollers can't both advance (and
 * both meter) the same unit; returns true only for the winner.
 */
export async function completeSarvamOcr(
  id: string,
  text: string,
  pages: number
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE job_batches
        SET status = CASE
                       WHEN job_kind = 'translate' THEN 'xlate_pending'
                       WHEN delivery = 'batch' THEN 'planned'
                       ELSE 'pending'
                     END,
            ocr_text = $2, sarvam_pages = $3, error = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'ocr_submitted'`,
    [id, text, pages]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Sarvam translation stage (jobs/sarvam-ocr.ts) ────────────────────────────
// Translation units are translated by Sarvam /translate before Claude structures
// them, so Claude neither reads nor translates — only parses prose into blocks.

/** How many times a unit may be sent to Sarvam /translate before Claude does it. */
export const MAX_XLATE_ATTEMPTS = Number(process.env.SARVAM_XLATE_MAX_ATTEMPTS) || 3;

/**
 * Claim units for translation, leasing them like the Claude drain does.
 *
 * Runnable = `xlate_pending`, or `xlate_processing` whose lease expired (the
 * worker holding it died). Throughput is bounded by the caller's `limit` rather
 * than a sliding window: one unit is ~15-20 /translate calls, and the endpoint
 * allows 60/min, so a few units per tick is the ceiling. See sarvam-ocr.ts.
 */
export async function claimXlateBatches(limit: number): Promise<BatchRow[]> {
  const { rows } = await pool.query<BatchRow>(
    `WITH c AS (
       SELECT id FROM job_batches
        WHERE (status = 'xlate_pending' AND xlate_attempts < $2)
           OR (status = 'xlate_processing' AND locked_at < NOW() - ($3 * INTERVAL '1 millisecond'))
        ORDER BY created_at, batch_index
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE job_batches b
        SET status = 'xlate_processing', locked_at = NOW(),
            xlate_attempts = b.xlate_attempts + 1, updated_at = NOW()
       FROM c WHERE b.id = c.id
     RETURNING b.*`,
    [limit, MAX_XLATE_ATTEMPTS, BATCH_LEASE_MS]
  );
  return rows;
}

/**
 * Store the translated text plus the detected source language, and hand the unit
 * to the Claude structuring phase. Guarded on `xlate_processing` so a reclaimed
 * lease can't double-advance the unit.
 */
export async function completeXlate(
  id: string,
  translatedText: string,
  sourceLanguage: string | null
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE job_batches
        SET status = CASE WHEN delivery = 'batch' THEN 'planned' ELSE 'pending' END,
            translated_text = $2, source_language = $3, error = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'xlate_processing'`,
    [id, translatedText, sourceLanguage]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Give up on translating this unit with Sarvam and let Claude translate it while
 * structuring — the behaviour before this stage existed. Used when the source
 * language can't be detected (/text-lid covers fewer languages than /translate),
 * when Sarvam errors, or when attempts run out. The unit KEEPS its ocr_text, so
 * Claude still works from Sarvam's read rather than re-reading the pixels.
 */
export async function fallbackToClaudeTranslation(
  ids: string[],
  reason: string
): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE job_batches
        SET status = CASE WHEN delivery = 'batch' THEN 'planned' ELSE 'pending' END,
            translated_text = NULL, error = $2, updated_at = NOW()
      WHERE id = ANY($1::uuid[])`,
    [ids, reason]
  );
}

/**
 * Return a unit to the translation queue for a later tick — used when Sarvam
 * throttles us mid-unit. `xlate_attempts` (incremented at claim time) is kept, so
 * a persistently-throttling translate endpoint eventually exhausts the unit and
 * revertExhaustedXlateUnits() hands it to Claude instead of looping forever.
 */
export async function requeueXlateUnits(ids: string[], reason: string): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE job_batches
        SET status = 'xlate_pending', error = $2, updated_at = NOW()
      WHERE id = ANY($1::uuid[]) AND status = 'xlate_processing'`,
    [ids, reason]
  );
}

/**
 * Backstop for the translation stage: a unit that exhausted its translate
 * attempts is handed to Claude rather than left cycling in the queue until the
 * 30-minute stale sweep fails the whole job. Returns affected job ids.
 */
export async function revertExhaustedXlateUnits(): Promise<string[]> {
  const { rows } = await pool.query<{ job_id: string }>(
    `UPDATE job_batches
        SET status = CASE WHEN delivery = 'batch' THEN 'planned' ELSE 'pending' END,
            translated_text = NULL,
            error = 'Translation service unavailable; translating normally.',
            updated_at = NOW()
      WHERE status = 'xlate_pending' AND xlate_attempts >= $1
      RETURNING job_id`,
    [MAX_XLATE_ATTEMPTS]
  );
  return [...new Set(rows.map((r) => r.job_id))];
}

/**
 * Fall back to reading with Claude vision: clear any Sarvam state and put the
 * unit on the normal path with no extracted text, so buildBatchContent sends the
 * source pixels. This is the safety valve for every Sarvam failure — job failed
 * or rejected, no credits, rate limited, empty output, or stalled in flight.
 * `attempts` is deliberately untouched: a Sarvam problem is not the unit's fault
 * and must not consume its Claude retries.
 */
export async function fallbackToVision(ids: string[], reason: string): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE job_batches
        SET status = CASE WHEN delivery = 'batch' THEN 'planned' ELSE 'pending' END,
            ocr_text = NULL, sarvam_job_id = NULL, sarvam_submitted_at = NULL,
            error = $2, updated_at = NOW()
      WHERE id = ANY($1::uuid[])`,
    [ids, reason]
  );
}

/**
 * Return a claimed unit to the Sarvam queue without consuming its fallback.
 * Used when Sarvam rate-limits us — we simply over-estimated our share of the
 * 10/min budget (another process may use the same account), which is not a
 * reason to pay for the more expensive Claude read.
 *
 * `sarvam_submitted_at` is deliberately KEPT: a throttled request still hit the
 * account, so it must stay counted in the rate-limit window or the next tick
 * would over-claim again. `sarvam_attempts` (already incremented at claim time)
 * is likewise kept, so a permanently-throttling Sarvam eventually exhausts the
 * unit's attempts and revertStuckSarvamUnits() hands it to Claude.
 */
export async function requeueSarvamUnits(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE job_batches
        SET status = 'ocr_pending', sarvam_job_id = NULL, updated_at = NOW()
      WHERE id = ANY($1::uuid[]) AND status = 'ocr_submitted'`,
    [ids]
  );
}

/**
 * Dead-man's switch for the Sarvam phase, mirroring revertExpiredBatchUnits().
 * Rescues the two ways a unit can get stranded before Claude ever sees it, both
 * by handing it to the Claude vision path:
 *
 *   1. stuck `ocr_submitted` past the max age — its Sarvam job never reached a
 *      terminal status (lost job, or a backlog beyond the poll LIMIT so it was
 *      never polled);
 *   2. back in `ocr_pending` with its Sarvam attempts exhausted — Sarvam keeps
 *      throttling or erroring, and without this the unit would cycle between
 *      queue and throttle until the 30-minute stale sweep failed the whole job.
 *
 * Returns affected job ids.
 */
export async function revertStuckSarvamUnits(
  maxAgeMs: number = SARVAM_MAX_INFLIGHT_MS
): Promise<string[]> {
  const { rows } = await pool.query<{ job_id: string }>(
    `UPDATE job_batches
        SET status = CASE WHEN delivery = 'batch' THEN 'planned' ELSE 'pending' END,
            ocr_text = NULL, sarvam_job_id = NULL, sarvam_submitted_at = NULL,
            error = 'Document reader unavailable; processing normally.',
            updated_at = NOW()
      WHERE (
              status = 'ocr_submitted'
              AND sarvam_submitted_at < NOW() - ($1 * INTERVAL '1 millisecond')
            )
         OR (status = 'ocr_pending' AND sarvam_attempts >= $2)
      RETURNING job_id`,
    [maxAgeMs, MAX_SARVAM_ATTEMPTS]
  );
  return [...new Set(rows.map((r) => r.job_id))];
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
