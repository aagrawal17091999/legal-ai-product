-- Migration 019: persist the structured translation result.
--
-- Until now only the rendered .docx was stored (output_r2_key). The structured
-- TranslationResult (detected/target language + per-segment translation, flagged
-- markers and notes) was thrown away after rendering, so a finished translation
-- could only ever be re-downloaded as a binary — never reopened or previewed
-- in-app. Store it as JSONB so the history viewer can render it without fetching
-- or re-parsing the .docx. Nullable: jobs created before this migration keep
-- NULL and the viewer falls back to "download the .docx".
BEGIN;

ALTER TABLE translation_jobs ADD COLUMN IF NOT EXISTS result_json JSONB;

COMMIT;
