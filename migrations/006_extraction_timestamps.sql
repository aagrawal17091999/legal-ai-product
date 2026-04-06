-- Add extraction_updated_at to track when extraction was last run.
-- extracted_at remains as the first extraction timestamp.

ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS extraction_updated_at TIMESTAMP;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS extraction_updated_at TIMESTAMP;

-- Backfill: set extraction_updated_at = extracted_at for existing rows
UPDATE supreme_court_cases SET extraction_updated_at = extracted_at WHERE extracted_at IS NOT NULL AND extraction_updated_at IS NULL;
UPDATE high_court_cases SET extraction_updated_at = extracted_at WHERE extracted_at IS NOT NULL AND extraction_updated_at IS NULL;
