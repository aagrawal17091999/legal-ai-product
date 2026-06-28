-- Migration 024: Anthropic Batch API delivery for large OCR/Translation jobs.
--
-- Big documents (> BATCH_API_MIN_PAGES, default 30) don't need the fast
-- synchronous path. Instead of the cron worker running each 6-page unit as a
-- live vision call, we submit ALL of a job's units to ONE Anthropic Message
-- Batch (50% cheaper, async, "usually < 1h / max 24h"). A poller fills the SAME
-- job_batches.result_json and flips the units to `done`; the existing reconcile
-- + assembly path then settles the job unchanged.
--
-- Per-unit lifecycle on the Batch path:
--   planned -> submitting -> submitted -> done | (pending = sync fallback)
-- The sync path is unchanged: pending -> processing -> done | failed.
BEGIN;

-- How this unit is processed. 'sync' = live vision call in the worker (current
-- behaviour, default). 'batch' = submitted to the Anthropic Message Batch API.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS delivery TEXT NOT NULL DEFAULT 'sync';

-- The Anthropic Message Batch id this unit was submitted in. One batch per job;
-- the unit's own id is used as the batch request custom_id, so results route
-- back by id with no extra mapping table.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS provider_batch_id TEXT;

-- Poller: find in-flight batches to retrieve (status = 'submitted').
CREATE INDEX IF NOT EXISTS idx_job_batches_provider
  ON job_batches (provider_batch_id) WHERE provider_batch_id IS NOT NULL;

-- Submitter: find jobs with units still waiting to be submitted.
CREATE INDEX IF NOT EXISTS idx_job_batches_planned
  ON job_batches (job_kind, job_id) WHERE status = 'planned';

-- Tag batch-delivered usage. For a batch row, cost_inr/credits_charged are the
-- SYNC-EQUIVALENT figure (2x the actual Batch-API cost — we don't pass the 50%
-- discount to users), so the real rupee spend for a batch row is cost_inr / 2.
-- This flag lets margin analytics recover true COGS.
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS batch_api BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
