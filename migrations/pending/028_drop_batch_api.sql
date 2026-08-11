-- Migration 028: remove the Anthropic Message Batch API delivery path.
--
-- The Batch API traded up to 24h of latency for a 50% discount. For a
-- user-facing OCR/translation product that is the wrong trade — a lawyer
-- uploading a document will not wait a day — so the feature is gone rather than
-- left switched off behind BATCH_API_ENABLED, where it would rot.
--
-- This UNDOES migration 024. The `job_batches` work queue itself (migration 022)
-- is untouched: that is the 6-page-unit execution engine for OCR + Translation,
-- not "batching" in the provider sense.
--
-- DEPLOY ORDER MATTERS. Per docs/deploying-changes.md, migrations must be
-- backward-compatible so a code rollback never meets a schema it can't handle.
-- Dropping these columns in the same deploy that stops writing them would break
-- that rule. So:
--   Deploy 1  ship the code that no longer reads/writes these columns.
--   Deploy 2  (this file) drop them, once Deploy 1 is confirmed stable.
--
-- PRE-FLIGHT — this must return 0 before applying:
--   SELECT count(*) FROM job_batches
--    WHERE status IN ('planned', 'submitting', 'submitted');
-- A non-zero count means units are still mid-flight on the Batch API; they would
-- be orphaned by this migration. Revert them to the sync path first:
--   UPDATE job_batches SET status = 'pending'
--    WHERE status IN ('planned', 'submitting', 'submitted');
BEGIN;

-- Safety net: if any units are still on the batch lifecycle, put them back on
-- the synchronous path rather than stranding them in a status no code handles.
-- A no-op on a clean database.
UPDATE job_batches
   SET status = 'pending', updated_at = NOW()
 WHERE status IN ('planned', 'submitting', 'submitted');

DROP INDEX IF EXISTS idx_job_batches_provider;
DROP INDEX IF EXISTS idx_job_batches_planned;

ALTER TABLE job_batches DROP COLUMN IF EXISTS delivery;
ALTER TABLE job_batches DROP COLUMN IF EXISTS provider_batch_id;

-- usage_events.batch_api recorded that a row's cost_inr was 2x the real spend
-- (we never passed the batch discount to users). With no batch path, cost_inr is
-- always the real figure and the flag is meaningless.
ALTER TABLE usage_events DROP COLUMN IF EXISTS batch_api;

COMMIT;
