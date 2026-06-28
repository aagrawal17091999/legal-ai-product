-- Migration 022: durable per-batch work queue for OCR + Translation.
--
-- Both pipelines split a document into page-range batches (≤6 pages each) and
-- run one vision call per batch. Previously every batch ran inside a single
-- `after()` background task bounded by the 300s function limit, so large
-- documents timed out. This table makes each batch an independently-claimable
-- unit of work: the cron worker (/api/cron/process-batches) claims pending rows
-- with FOR UPDATE SKIP LOCKED, runs the vision call for each in its own
-- invocation (a fresh 300s budget), and assembles the job once all its batches
-- are done. SKIP LOCKED also makes concurrent workers / multiple users safe with
-- no double-processing, and pending rows give natural backpressure under load.
--
-- `job_id` references either ocr_jobs.id or translation_jobs.id depending on
-- `job_kind` (no FK — the two parents share this queue). `result_json` holds the
-- raw {detected_language, blocks} the model returned for that batch, fed in
-- `batch_index` order to assembleBlocks() at the end.
BEGIN;

CREATE TABLE IF NOT EXISTS job_batches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL,
    job_kind    TEXT NOT NULL,                    -- 'ocr' | 'translate'
    batch_index INTEGER NOT NULL,                 -- reading order within the job
    page_start  INTEGER,                          -- 0-based inclusive; null for image/docx
    page_end    INTEGER,                          -- 0-based inclusive; null for image/docx
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    result_json JSONB,
    error       TEXT,
    locked_at   TIMESTAMP,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Claim path: pending rows, oldest job first (FIFO fairness across jobs), then
-- by reading order. Matches the worker's claim ORDER BY.
CREATE INDEX IF NOT EXISTS idx_job_batches_claim
    ON job_batches (status, created_at, batch_index);

-- Per-job lookups: completion check + gathering result_json in order to assemble.
CREATE INDEX IF NOT EXISTS idx_job_batches_job
    ON job_batches (job_id);

COMMIT;
