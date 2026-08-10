-- Migration 026: Sarvam Doc AI as the OCR reading step for OCR + Translation.
--
-- Previously ONE Claude vision call per batch unit both read the page pixels and
-- emitted the typed block model. That read step now goes to Sarvam Doc AI
-- (purpose-built for Indian-language scans, ₹0.50/page); Claude then structures
-- — and, for translation, translates — the extracted text. Claude's call becomes
-- text-only, so the block model, the `flagged` illegible-span markers, and the
-- kv/partyLabel/signature typing are all preserved.
--
-- Sarvam is asynchronous, so a unit gains a phase in FRONT of the existing queue:
--
--   pdf/image:  ocr_pending -> ocr_submitted -> pending  (or planned, if the unit
--                                    |                    was routed to the
--                                    |                    Anthropic Batch API)
--                                    +--> pending with ocr_text NULL
--                                         = Claude vision fallback, i.e. exactly
--                                           the old behaviour. Used whenever
--                                           Sarvam fails, 402s (no credits),
--                                           or stalls.
--   docx:       pending  (unchanged — mammoth already extracts text)
--
-- Once ocr_text is filled the unit re-enters the EXISTING pending path, so the
-- worker's drain, reconcile, assembly CAS, watchdog, metering, credit locking and
-- refunds all work unchanged.
--
-- Fully reversible by unsetting SARVAM_OCR_ENABLED: units then start `pending`
-- as before and these columns simply stay NULL. No down-migration needed.
BEGIN;

-- Markdown extracted by Sarvam for this unit's page range. NULL means "no Sarvam
-- text" — the worker then sends the source pixels to Claude exactly as it used to.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS ocr_text TEXT;

-- The Sarvam Doc AI job id this unit was submitted as (one Sarvam job per unit,
-- since Sarvam caps a job at 10 pages — the same as our per-unit page range).
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS sarvam_job_id TEXT;

-- When the unit was submitted to Sarvam. Two jobs depend on this:
--   1. the sliding-window rate limiter (Doc AI allows 10 req/min ACCOUNT-WIDE on
--      every plan tier — it cannot be raised, so we must self-throttle);
--   2. the dead-man's switch that falls a stalled unit back to Claude vision.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS sarvam_submitted_at TIMESTAMPTZ;

-- Pages Sarvam actually returned content for — what the ₹0.50/page charge meters on.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS sarvam_pages INTEGER;

-- Reading attempts spent on Sarvam. Deliberately SEPARATE from `attempts`, which
-- is the Claude retry budget: if a throttled Sarvam read consumed those, the
-- unit could arrive at the Claude phase with no retries left and fail on its
-- first hiccup. Once this hits its cap the unit stops trying Sarvam and is read
-- by Claude instead, so a persistent Sarvam problem can never wedge a job.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS sarvam_attempts INTEGER NOT NULL DEFAULT 0;

-- Submitter: find units waiting to go to Sarvam, oldest job first (FIFO fairness).
CREATE INDEX IF NOT EXISTS idx_job_batches_ocr_pending
  ON job_batches (created_at, batch_index) WHERE status = 'ocr_pending';

-- Poller: units still awaiting a Sarvam result.
CREATE INDEX IF NOT EXISTS idx_job_batches_sarvam_inflight
  ON job_batches (sarvam_submitted_at) WHERE status = 'ocr_submitted';

-- Rate-limit window: counts everything submitted in the last 60s regardless of
-- current status — a unit that already came back still consumed a request, so
-- filtering on status here would undercount and let us exceed 10/min.
CREATE INDEX IF NOT EXISTS idx_job_batches_sarvam_window
  ON job_batches (sarvam_submitted_at) WHERE sarvam_submitted_at IS NOT NULL;

COMMIT;
