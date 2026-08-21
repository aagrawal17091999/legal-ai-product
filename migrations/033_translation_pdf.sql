-- Migration 033: store a rendered PDF alongside the .docx for translations.
--
-- OCR jobs have always produced both a print-ready PDF and an editable .docx
-- (ocr_jobs.output_pdf_r2_key / output_docx_r2_key). Translations only ever
-- stored the .docx, so a finished translation could not be filed or shared
-- without someone opening Word and exporting it by hand. Store the PDF's R2 key
-- in its own column; the existing output_r2_key keeps meaning "the .docx" so
-- the currently-deployed code keeps working unchanged.
--
-- Nullable: jobs finished before this migration have no PDF and the UI simply
-- doesn't offer the button for them.
BEGIN;

ALTER TABLE translation_jobs ADD COLUMN IF NOT EXISTS output_pdf_r2_key TEXT;

COMMIT;
