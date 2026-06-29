import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { getR2Object } from "@/lib/r2";
import { runBatch } from "@/lib/vision/structured";
import {
  claimPendingBatches,
  completeBatch,
  recordBatchFailure,
  jobBatchState,
  findSettleableJobs,
  tryAcquireAssembly,
  failJob,
  sweepStaleJobs,
  queueDepth,
  jobTable,
  getJobSource,
  revertExpiredBatchUnits,
  STALE_JOB_MESSAGE,
  type BatchRow,
  type JobKind,
  type JobSource,
} from "@/lib/jobs/batches";
import { submitPlannedBatchJobs, pollInFlightBatchApi } from "@/lib/jobs/batch-api";
import { ocrBatchConfig } from "@/lib/ocr/ocr";
import { translateBatchConfig } from "@/lib/translate/translate";
import { assembleOcrJob } from "@/lib/ocr/process";
import { assembleTranslationJob } from "@/lib/translate/process";
import { mirrorJobStatus } from "@/lib/firebase-admin";
import { withMeter, markMeterUnbillable } from "@/lib/billing/meter";
import { getRemaining, refund } from "@/lib/billing/credits";
import { logError } from "@/lib/error-logger";

/**
 * Durable batch worker for OCR + Translation.
 *
 * Each invocation claims a bounded set of pending batches (FOR UPDATE SKIP
 * LOCKED), runs ONE vision call per batch in its own 300s budget, then — for any
 * job whose batches are now all settled — fails it (a batch exhausted retries) or
 * wins the assembly CAS and renders the final document. This is what lets large
 * documents and many concurrent users get processed without a single request ever
 * hitting the 300s cap. Vercel runs it every minute (vercel.json); it is also
 * safe to hit manually with the CRON_SECRET bearer token.
 */
export const maxDuration = 300;

// Concurrent vision calls in one wave — caps in-flight Anthropic calls so
// concurrent uploads degrade gracefully (excess stays `pending`/`processing`)
// instead of a 429 storm. Env-tunable: because the 210s budget exceeds the 60s
// cron interval, ~3-4 worker invocations overlap, so peak system-wide concurrency
// is roughly 4 × this value. Set it to (your Anthropic concurrent-request budget
// ÷ ~4); raise it as the first throughput lever when backlog grows.
const WORKER_CONCURRENCY = Number(process.env.BATCH_WORKER_CONCURRENCY) || 5;
// Keep draining waves until this wall-clock budget, leaving margin under the 300s
// maxDuration for the final wave + assembly. A wave that overruns is harmless:
// its batches keep their lease and get reclaimed by a later tick.
const WORKER_BUDGET_MS = Number(process.env.BATCH_WORKER_BUDGET_MS) || 210_000;
// Log a warning when the pending backlog exceeds this — the cue to scale.
const BACKLOG_ALERT = Number(process.env.BATCH_BACKLOG_ALERT) || 200;

// Self-chaining fan-out. The cron-triggered "dispatcher" can launch extra peer
// invocations that drain the same queue in parallel (SKIP LOCKED keeps them
// disjoint). Only the dispatcher spawns, and peers never spawn — so the per-tick
// invocation count is hard-capped at BATCH_MAX_LANES (no exponential fan-out).
// Default 1 = fan-out OFF (behaviour unchanged); raise it once DB pooling is in
// place and you have Anthropic rate-limit headroom. Peak concurrency scales with
// BATCH_MAX_LANES × BATCH_WORKER_CONCURRENCY (× the ~3-4 natural cron overlap).
const MAX_LANES = Math.max(1, Number(process.env.BATCH_MAX_LANES) || 1);
// Add one peer lane per this many pending batches (backlog-proportional), capped
// at MAX_LANES. Keeps idle ticks from spawning peers that would find no work.
const PENDING_PER_LANE = Number(process.env.BATCH_PENDING_PER_LANE) || 25;

/**
 * After a job is assembled, withhold its output if metering this user's batches
 * pushed their wallet negative (they ran while low on credits). The output stays
 * stored; the GET route hides the download until a top-up restores a positive
 * balance (credits.unlockOutputs). No-op in shadow mode (no debits → never < 0).
 */
async function lockOutputIfNegative(kind: JobKind, jobId: string): Promise<void> {
  const { rows } = await pool.query<{ user_id: number }>(
    `SELECT user_id FROM ${jobTable(kind)} WHERE id = $1`,
    [jobId]
  );
  const userId = rows[0]?.user_id;
  if (!userId) return;
  if ((await getRemaining(userId)) < 0) {
    await pool.query(
      `UPDATE ${jobTable(kind)} SET output_locked = TRUE, updated_at = NOW() WHERE id = $1`,
      [jobId]
    );
  }
}

async function processOne(
  batch: BatchRow,
  source: JobSource,
  buffer: Buffer
): Promise<void> {
  const cfg =
    batch.job_kind === "ocr"
      ? ocrBatchConfig()
      : translateBatchConfig(source.target_language ?? "");
  // Meter this batch's vision call against the job owner's wallet. One
  // usage_events row per batch; debits accumulate across the job's batches.
  const { result } = await withMeter(
    {
      userId: source.user_id,
      feature: batch.job_kind === "ocr" ? "ocr" : "translate",
      refId: batch.job_id,
    },
    async () => {
      const r = await runBatch(
        buffer,
        source.source_mime,
        source.source_filename,
        { index: batch.batch_index, pageStart: batch.page_start, pageEnd: batch.page_end },
        cfg.prompt,
        cfg.feature,
        cfg.model,
        cfg.schema
      );
      // A failed attempt may still have consumed some tokens before the call
      // errored/parsed empty. Don't bill the user for it — only a successful
      // batch is charged (and the retry that finally succeeds is charged once).
      if (!r) markMeterUnbillable();
      return r;
    }
  );
  if (result) {
    await completeBatch(batch.id, result);
  } else {
    await recordBatchFailure(batch.id, batch.attempts, "Vision call failed for this batch.");
  }
}

/**
 * When a job fails as a whole, credit back whatever its already-completed batches
 * were charged (a partial-failure document otherwise leaves the user paying for
 * pages they never receive). Sums the enforced charges recorded against this job
 * and issues one refund. Runs at most once per job (failJob is CAS-guarded).
 */
async function refundFailedJob(kind: JobKind, jobId: string): Promise<void> {
  const { rows } = await pool.query<{ user_id: number }>(
    `SELECT user_id FROM ${jobTable(kind)} WHERE id = $1`,
    [jobId]
  );
  const userId = rows[0]?.user_id;
  if (!userId) return;
  const { rows: sums } = await pool.query<{ c: number }>(
    `SELECT COALESCE(SUM(credits_charged), 0)::int AS c
       FROM usage_events
      WHERE ref_id = $1 AND user_id = $2 AND enforced = TRUE`,
    [jobId, userId]
  );
  const credits = sums[0]?.c ?? 0;
  if (credits > 0) await refund(userId, credits);
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logError({
      category: "extraction",
      message: "CRON_SECRET not set — batch worker refusing to run",
      severity: "critical",
      endpoint: "/api/cron/process-batches",
    });
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  if (request.headers.get("Authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A peer is a fan-out worker spawned by the dispatcher; it only drains +
  // reconciles and never spawns further (this is what bounds total invocations).
  const isPeer = new URL(request.url).searchParams.get("peer") === "1";

  try {
    // Watchdog (dispatcher only, client-independent): fail jobs wedged past the
    // timeout and push the terminal status so the UI stops spinning.
    let swept = 0;
    let batchSubmitted = 0;
    let batchDone = 0;
    let batchFailed = 0;
    if (!isPeer) {
      for (const kind of ["ocr", "translate"] as const) {
        const stale = await sweepStaleJobs(kind);
        for (const id of stale) {
          await mirrorJobStatus(kind, id, { status: "failed", error: STALE_JOB_MESSAGE });
          swept++;
        }
      }

      // Fan-out: launch peer lanes proportional to the current backlog, capped at
      // MAX_LANES. Fire-and-forget BEFORE draining so peers run in parallel with
      // this dispatcher. They authenticate with the same CRON_SECRET.
      if (MAX_LANES > 1) {
        const { pending } = await queueDepth();
        const peers = Math.min(MAX_LANES - 1, Math.floor(pending / PENDING_PER_LANE));
        if (peers > 0) {
          const peerUrl = new URL(request.url);
          peerUrl.searchParams.set("peer", "1");
          for (let i = 0; i < peers; i++) {
            void fetch(peerUrl.toString(), {
              headers: { Authorization: `Bearer ${secret}` },
            }).catch(() => {
              /* a dropped spawn is non-fatal — the next cron tick re-evaluates. */
            });
          }
        }
      }

      // Batch-API delivery (dispatcher only): submit planned large jobs to the
      // Anthropic Message Batch API, then pull results for any batch that ended.
      // Both write the same job_batches.result_json the sync path uses, so the
      // reconcile pass below settles batch jobs unchanged. Runs before the drain
      // so a freshly-completed batch unit's debit is recorded ahead of assembly's
      // output-lock check. Self-contained failures fall back to the sync queue.
      try {
        // Dead-man's switch: revert units stuck `submitted` past the max batch
        // window back to the sync path, so a lost Anthropic batch can't leave a
        // job spinning forever (these units are exempt from the stale sweep).
        const expired = await revertExpiredBatchUnits();
        if (expired.length > 0) {
          logError({
            category: "extraction",
            message: `Reverted ${expired.length} stuck Batch-API job(s) to sync after max age`,
            severity: "warning",
            endpoint: "/api/cron/process-batches",
            metadata: { jobIds: expired },
          });
        }
        batchSubmitted = await submitPlannedBatchJobs();
        const polled = await pollInFlightBatchApi();
        batchDone = polled.done;
        batchFailed = polled.failed;
      } catch (err) {
        logError({
          category: "extraction",
          message: `Batch-API step failed: ${err instanceof Error ? err.message : String(err)}`,
          error: err,
          severity: "error",
          endpoint: "/api/cron/process-batches",
        });
      }
    }

    // Drain waves until the time budget runs out (or no work remains). Each wave
    // runs ≤ WORKER_CONCURRENCY vision calls concurrently, so peak in-flight
    // Anthropic calls stay bounded; the loop is what raises per-invocation
    // throughput without a single wave ever approaching the 300s cap. Source
    // buffers are cached across waves so a job's repeated batches reuse one R2 read.
    const deadline = Date.now() + WORKER_BUDGET_MS;
    const sources = new Map<string, JobSource | null>();
    const buffers = new Map<string, Buffer>();
    let claimed = 0;

    while (Date.now() < deadline) {
      const wave = await claimPendingBatches(WORKER_CONCURRENCY);
      if (wave.length === 0) break;
      claimed += wave.length;

      for (const b of wave) {
        if (sources.has(b.job_id)) continue;
        const src = await getJobSource(b.job_kind, b.job_id);
        sources.set(b.job_id, src);
        if (src) buffers.set(b.job_id, await getR2Object(src.source_r2_key));
      }

      await Promise.all(
        wave.map(async (b) => {
          const src = sources.get(b.job_id);
          const buf = buffers.get(b.job_id);
          if (!src || !buf) {
            // Parent row vanished or source unreadable — don't burn retries forever.
            await recordBatchFailure(b.id, b.attempts, "Job source unavailable.");
            return;
          }
          try {
            await processOne(b, src, buf);
          } catch (err) {
            await recordBatchFailure(
              b.id,
              b.attempts,
              err instanceof Error ? err.message : String(err)
            );
          }
        })
      );
    }

    // Reconcile: settle every job whose batches are all done — independent of what
    // THIS invocation claimed. This catches jobs finished by a concurrent worker
    // or orphaned by a crash, so a fully-processed document never waits for the
    // stale sweep. CAS in failJob/tryAcquireAssembly keeps it safe under races.
    let assembled = 0;
    let failed = 0;
    const failMsg =
      "One or more sections of this document could not be processed. Please try again.";
    for (const kind of ["ocr", "translate"] as const) {
      for (const jobId of await findSettleableJobs(kind)) {
        const state = await jobBatchState(jobId);
        if (state.outstanding > 0) continue; // raced with a new claim — leave it
        if (state.failed > 0) {
          if (await failJob(kind, jobId, failMsg)) {
            await mirrorJobStatus(kind, jobId, { status: "failed", error: failMsg });
            // Refund any successfully-processed sections the user was charged for.
            await refundFailedJob(kind, jobId);
            failed++;
          }
          continue;
        }
        if (await tryAcquireAssembly(kind, jobId)) {
          if (kind === "ocr") await assembleOcrJob(jobId);
          else await assembleTranslationJob(jobId);
          // Withhold the finished output if the user ran out of credits midway.
          await lockOutputIfNegative(kind, jobId);
          assembled++;
        }
      }
    }

    // Backlog snapshot for observability — surface as a warning when it grows so
    // there's a clear cue to raise BATCH_WORKER_CONCURRENCY (or add lanes).
    const { pending, oldestCreatedAt } = await queueDepth();
    const oldestAgeMs = oldestCreatedAt ? Date.now() - oldestCreatedAt.getTime() : 0;
    // Dispatcher-only alert so overlapping peers don't multiply the warning.
    if (!isPeer && pending > BACKLOG_ALERT) {
      logError({
        category: "extraction",
        message: `Batch queue backlog high: ${pending} pending, oldest ${Math.round(oldestAgeMs / 1000)}s`,
        severity: "warning",
        endpoint: "/api/cron/process-batches",
        metadata: { pending, oldestAgeMs },
      });
    }

    return NextResponse.json({
      status: "ok",
      lane: isPeer ? "peer" : "dispatcher",
      claimed,
      assembled,
      failed,
      swept,
      batchSubmitted,
      batchDone,
      batchFailed,
      pending,
      oldestAgeMs,
    });
  } catch (err) {
    logError({
      category: "extraction",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      endpoint: "/api/cron/process-batches",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
