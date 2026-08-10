-- Migration 027: Sarvam translates the text too; Claude only structures it.
--
-- Migration 026 moved the OCR *read* to Sarvam. This moves the TRANSLATION as
-- well, so the translation pipeline is now three stages instead of one:
--
--   ocr_pending -> ocr_submitted    Sarvam Doc AI reads the pages    (026)
--     -> xlate_pending -> xlate_processing   Sarvam /translate translates  (this)
--       -> pending | planned        Claude structures into blocks
--         -> processing -> done
--
-- Claude's remaining job — turning prose into the typed block model — no longer
-- involves reading pixels OR translating, which is why the structuring step can
-- run on Haiku (see ocr.ts / translate.ts model selection). The Claude vision
-- fallback still runs on Sonnet, because reading degraded scans is the thing
-- Haiku was measurably bad at.
--
-- The OCR feature skips the xlate stage entirely (nothing to translate).
--
-- Every stage degrades independently: no translated_text means Claude translates
-- as it did before, and no ocr_text means Claude reads the pixels as it did
-- before. Unsetting SARVAM_OCR_ENABLED restores the original single-pass path.
BEGIN;

-- Target-language text returned by Sarvam /translate for this unit. NULL means
-- "not translated by Sarvam" — Claude then translates as well as structures.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS translated_text TEXT;

-- Source language detected by Sarvam /text-lid (BCP-47, e.g. 'hi-IN').
-- Authoritative for the job's detected_language: once the text handed to Claude
-- is ALREADY in the target language, Claude can no longer tell what the source
-- was, so it must come from here.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS source_language TEXT;

-- Translation attempts, counted separately from `attempts` (Claude's retry
-- budget) and `sarvam_attempts` (the read budget) for the same reason: one
-- stage's trouble must never eat another stage's retries.
ALTER TABLE job_batches
  ADD COLUMN IF NOT EXISTS xlate_attempts INTEGER NOT NULL DEFAULT 0;

-- Claim path for the translation stage, oldest job first (FIFO fairness).
CREATE INDEX IF NOT EXISTS idx_job_batches_xlate_pending
  ON job_batches (created_at, batch_index) WHERE status = 'xlate_pending';

-- Lease reclaim for units whose worker died mid-translation.
CREATE INDEX IF NOT EXISTS idx_job_batches_xlate_processing
  ON job_batches (locked_at) WHERE status = 'xlate_processing';

COMMIT;
