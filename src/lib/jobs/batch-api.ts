/**
 * Anthropic Message Batch API delivery for large OCR/Translation jobs.
 *
 * Big documents (> BATCH_API_MIN_PAGES) skip the synchronous vision worker.
 * Instead, all of a job's 6-page units are submitted as ONE Anthropic Message
 * Batch — 50% cheaper, async ("usually < 1h / max 24h"). This module owns the
 * two background steps the cron worker drives each tick:
 *
 *   submitPlannedBatchJobs()  planned → submitting → submitted   (one batch/job)
 *   pollInFlightBatchApi()    submitted → done                   (results land)
 *
 * Both write the SAME job_batches.result_json the sync path uses, so the worker's
 * existing reconcile + assembly settles batch jobs with no special-casing. Submit
 * failures and unusable/expired results fall back to the sync path (→ pending).
 *
 * Pricing: a batch unit is metered at FULL (sync) rates — i.e. 2x the actual
 * half-price batch cost — so users never see the discount and we bank it as
 * margin. The usage_events.batch_api flag records that real spend = cost_inr / 2.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "../claude";
import { getR2Object } from "../r2";
import {
  buildBatchContent,
  resolveVisionModel,
  parseVisionMessage,
  VISION_MAX_TOKENS,
  type BatchPlan,
} from "../vision/structured";
import { ocrBatchConfig } from "../ocr/ocr";
import { translateBatchConfig } from "../translate/translate";
import {
  findPlannedJobs,
  claimJobForSubmission,
  markBatchSubmitted,
  revertUnitsToSync,
  findInFlightProviderBatches,
  getProviderBatchUnits,
  completeSubmittedBatch,
  getJobSource,
  type JobKind,
  type JobSource,
} from "./batches";
import { withMeter, addClaudeUsage } from "../billing/meter";
import { logError } from "../error-logger";

/** Documents with more pages than this go to the Batch API; smaller ones stay on
 *  the fast synchronous path. Only multi-page PDFs ever exceed it. */
export const BATCH_API_MIN_PAGES = Number(process.env.BATCH_API_MIN_PAGES) || 30;

/** Decide a job's delivery from its plan. Gated behind BATCH_API_ENABLED so the
 *  feature is off (behaviour unchanged) until explicitly switched on. */
export function shouldUseBatchApi(plan: BatchPlan): boolean {
  return (
    process.env.BATCH_API_ENABLED === "on" &&
    plan.kind === "pdf" &&
    plan.totalPages > BATCH_API_MIN_PAGES
  );
}

function batchConfig(kind: JobKind, src: JobSource) {
  return kind === "ocr" ? ocrBatchConfig() : translateBatchConfig(src.target_language ?? "");
}

/**
 * Submit each planned job's units as one Anthropic Message Batch. Each job is
 * claimed atomically (claimJobForSubmission), so concurrent workers never submit
 * the same job twice. The unit's id is the request custom_id, so results route
 * back by id with no mapping table. On any failure the units fall back to sync.
 * Returns the number of jobs submitted.
 */
export async function submitPlannedBatchJobs(jobsPerKind = 5): Promise<number> {
  const client = getAnthropicClient();
  let submitted = 0;

  for (const kind of ["ocr", "translate"] as const) {
    for (const jobId of await findPlannedJobs(kind, jobsPerKind)) {
      const units = await claimJobForSubmission(jobId);
      if (units.length === 0) continue; // another worker claimed it

      const ids = units.map((u) => u.id);
      try {
        const src = await getJobSource(kind, jobId);
        if (!src) {
          await revertUnitsToSync(ids, "Job source unavailable.");
          continue;
        }
        const buffer = await getR2Object(src.source_r2_key);
        const cfg = batchConfig(kind, src);
        const model = resolveVisionModel(cfg.model);

        const requests = await Promise.all(
          units.map(async (u) => {
            const content = await buildBatchContent(
              buffer,
              src.source_mime,
              src.source_filename,
              { index: u.batch_index, pageStart: u.page_start, pageEnd: u.page_end },
              cfg.prompt
            );
            return {
              custom_id: u.id,
              params: {
                model,
                max_tokens: VISION_MAX_TOKENS,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                messages: [{ role: "user", content: content as any }],
                ...(cfg.schema
                  ? { output_config: { format: { type: "json_schema" as const, schema: cfg.schema } } }
                  : {}),
              },
            };
          })
        );

        const batch = await client.messages.batches.create({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          requests: requests as any,
        });
        await markBatchSubmitted(ids, batch.id);
        submitted++;
      } catch (err) {
        logError({
          category: "extraction",
          message: `Batch submit failed for ${kind} job ${jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          error: err,
          severity: "error",
          metadata: { feature: "batch_api_submit", kind, jobId },
        });
        // Don't strand the job — let the synchronous worker finish it.
        await revertUnitsToSync(ids, "Batch submission failed; processing normally.");
      }
    }
  }
  return submitted;
}

/** Meter one completed Batch-API unit at full (sync) rates — the 2x rule. */
async function meterBatchResult(
  userId: number,
  kind: JobKind,
  jobId: string,
  message: Anthropic.Message
): Promise<void> {
  await withMeter(
    { userId, feature: kind === "ocr" ? "ocr" : "translate", refId: jobId, batchApi: true },
    async () => {
      addClaudeUsage(message.model, message.usage);
    }
  );
}

/**
 * Poll each in-flight Anthropic batch. When one is `ended`, stream its results,
 * write each into its job_batches row (done), and meter it. Unusable or expired
 * results fall back to the sync path. Jobs whose final unit lands here are settled
 * by the worker's existing reconcile pass on the same tick.
 */
export async function pollInFlightBatchApi(maxBatches = 25): Promise<{ done: number; failed: number }> {
  const client = getAnthropicClient();
  let done = 0;
  let failed = 0;

  for (const batchId of await findInFlightProviderBatches(maxBatches)) {
    let status: string;
    try {
      const batch = await client.messages.batches.retrieve(batchId);
      status = batch.processing_status;
    } catch (err) {
      logError({
        category: "extraction",
        message: `Batch retrieve failed for ${batchId}: ${err instanceof Error ? err.message : String(err)}`,
        error: err,
        severity: "warning",
        metadata: { feature: "batch_api_poll", batchId },
      });
      continue;
    }
    if (status !== "ended") continue; // still running — try again next tick

    // Map each unit id → its job/kind, and cache job owners for metering.
    const units = await getProviderBatchUnits(batchId);
    const unitById = new Map(units.map((u) => [u.id, u]));
    const owners = new Map<string, { userId: number; kind: JobKind } | null>();

    try {
      for await (const r of await client.messages.batches.results(batchId)) {
        const unit = unitById.get(r.custom_id);
        if (!unit) continue; // already reconciled (e.g. reverted to sync)

        if (r.result.type === "succeeded") {
          const message = r.result.message;
          const parsed = parseVisionMessage(message);
          if (parsed) {
            // Meter ONLY if this call actually flipped submitted → done. Overlapping
            // cron invocations can stream the same ended batch concurrently; without
            // this guard each poller would meter the unit, charging it 2-4x.
            const flipped = await completeSubmittedBatch(unit.id, parsed);
            if (!flipped) continue; // another worker already settled + metered it
            done++;
            // Meter against the job owner (cache the lookup per job).
            if (!owners.has(unit.job_id)) {
              const src = await getJobSource(unit.job_kind, unit.job_id);
              owners.set(unit.job_id, src ? { userId: src.user_id, kind: unit.job_kind } : null);
            }
            const owner = owners.get(unit.job_id);
            if (owner) {
              await meterBatchResult(owner.userId, owner.kind, unit.job_id, message);
            }
            continue;
          }
        }
        // errored | canceled | expired | unparseable → finish it synchronously.
        await revertUnitsToSync([unit.id], `Batch result: ${r.result.type}`);
        failed++;
      }
    } catch (err) {
      logError({
        category: "extraction",
        message: `Batch results stream failed for ${batchId}: ${err instanceof Error ? err.message : String(err)}`,
        error: err,
        severity: "error",
        metadata: { feature: "batch_api_poll", batchId },
      });
      // Leave units `submitted`; the next tick retries this batch.
    }
  }
  return { done, failed };
}
