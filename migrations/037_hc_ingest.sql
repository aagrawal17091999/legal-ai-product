-- Migration 037: High Court ingestion (pipeline/ingest_hc.py).
--
-- Source: s3://indian-high-court-judgments (eCourts judgment portal, CC-BY-4.0).
-- One upstream PDF = one row. The PDF filename is CNR_ORDERNO_DECISIONDATE.pdf,
-- which is exactly the identity upstream recommends (cnr, order number,
-- decision date), so it is the dedup key here.
--
-- Additive only: every column is nullable, so rows loaded before this
-- migration (there are none in prod at time of writing) stay valid.
BEGIN;

ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS source_file TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_hc_source_file
    ON high_court_cases (source_file) WHERE source_file IS NOT NULL;

-- Provenance of judgment_text, so a bad batch can be found and redone.
--   page_count        pages in the PDF
--   text_source       pdf_text | tesseract | claude | mixed (text layer + OCR)
--   text_class        digital | garbled | scan | hindi | mixed | empty
--   ocr_pages         pages whose text came from OCR rather than the text layer
--   ocr_confidence    Tesseract word confidence (0-100), length-weighted over
--                     the OCR'd pages; NULL when nothing was OCR'd
--   needs_second_pass the free pass judged its own OCR unreliable; the paid
--                     pass (ingest_hc.py second-pass) picks these up
--   poor_pages        0-based pages the free pass judged unreliable; the paid
--                     pass re-reads only these, not the whole document
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS page_count INTEGER;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS text_source TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS text_class TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS ocr_pages INTEGER;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS ocr_confidence REAL;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS needs_second_pass BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS poor_pages INTEGER[];
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS second_pass_at TIMESTAMPTZ;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS ingest_batch_id INTEGER;

-- Connected matters decided together share one judgment, and upstream stores
-- a copy of the PDF under each case's CNR (19 copies of one 41-page Rajasthan
-- judgment in a single test batch). Every copy keeps its row, because each is
-- a case someone may look up, but only the first is embedded and LLM-read;
-- the rest point at it.
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS duplicate_of INTEGER;
CREATE INDEX IF NOT EXISTS idx_hc_content_hash
    ON high_court_cases (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hc_needs_second_pass
    ON high_court_cases (id) WHERE needs_second_pass AND second_pass_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hc_ingest_batch ON high_court_cases (ingest_batch_id);

-- One row per pipeline run: what it touched and what it cost. Costs are
-- computed from the token counts the APIs report, at the RATES in
-- pipeline/ingest_hc.py, so they can be recomputed if a rate changes.
CREATE TABLE IF NOT EXISTS hc_ingest_batches (
    id                    SERIAL PRIMARY KEY,
    kind                  TEXT NOT NULL,          -- batch | sync | second_pass
    args                  JSONB NOT NULL DEFAULT '{}',
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ,
    status                TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
    docs_selected         INTEGER NOT NULL DEFAULT 0,
    docs_inserted         INTEGER NOT NULL DEFAULT 0,
    docs_failed           INTEGER NOT NULL DEFAULT 0,
    pages_total           INTEGER NOT NULL DEFAULT 0,
    pages_ocr_free        INTEGER NOT NULL DEFAULT 0,
    pages_ocr_paid        INTEGER NOT NULL DEFAULT 0,
    docs_flagged          INTEGER NOT NULL DEFAULT 0,
    docs_llm_extracted    INTEGER NOT NULL DEFAULT 0,
    docs_embedded         INTEGER NOT NULL DEFAULT 0,
    chunks_created        INTEGER NOT NULL DEFAULT 0,
    claude_input_tokens   BIGINT NOT NULL DEFAULT 0,
    claude_output_tokens  BIGINT NOT NULL DEFAULT 0,
    voyage_tokens         BIGINT NOT NULL DEFAULT 0,
    ocr_cpu_seconds       REAL NOT NULL DEFAULT 0,
    cost_usd              NUMERIC(12, 4) NOT NULL DEFAULT 0,
    summary               JSONB NOT NULL DEFAULT '{}'
);

-- Upstream files that could not be loaded (download or parse failure).
-- Selection skips a file once it has failed 3 times.
CREATE TABLE IF NOT EXISTS hc_ingest_failures (
    source_file   TEXT PRIMARY KEY,
    attempts      INTEGER NOT NULL DEFAULT 1,
    last_error    TEXT,
    last_batch_id INTEGER,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
