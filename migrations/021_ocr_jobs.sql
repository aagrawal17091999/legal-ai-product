-- Migration 021: OCR jobs.
--
-- The OCR feature mirrors the translation pipeline (migration 018) but does NOT
-- translate: a single vision-native pass transcribes the source faithfully in
-- its original language, preserving structure, and renders BOTH a PDF (primary
-- download) and an editable DOCX. So there is no `target_language` column and
-- there are two output keys instead of one.
--
-- The structured block result is stored as JSONB (result_json) so the in-app
-- viewer can render it without fetching or re-parsing the output files.
BEGIN;

CREATE TABLE IF NOT EXISTS ocr_jobs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            INTEGER NOT NULL REFERENCES users(id),
    source_filename    TEXT NOT NULL,
    source_mime        TEXT NOT NULL,
    source_r2_key      TEXT NOT NULL,
    detected_language  TEXT,
    status             TEXT NOT NULL DEFAULT 'processing',
    output_pdf_r2_key  TEXT,
    output_docx_r2_key TEXT,
    segment_count      INTEGER NOT NULL DEFAULT 0,
    flagged_count      INTEGER NOT NULL DEFAULT 0,
    ocr_used           BOOLEAN NOT NULL DEFAULT FALSE,
    result_json        JSONB,
    error              TEXT,
    created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ocr_jobs_user
    ON ocr_jobs (user_id, created_at DESC);

COMMIT;
