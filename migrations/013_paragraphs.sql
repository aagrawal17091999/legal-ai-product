-- Migration 013: paragraph-aware ingestion.
--
-- Context: the chunker in pipeline/chunk_utils.py produces fixed-size
-- 2000-char windows. Paragraph numbers are lost, so follow-ups like
-- "what's in paragraph 42 of Sisodia" cannot be grounded even in principle.
--
-- This migration introduces two additions:
--   1) case_paragraphs — one row per paragraph extracted from each judgment.
--      Used for addressability ("give me paragraph 42") and as the unit the
--      new chunking policy builds around.
--   2) case_chunks.paragraph_numbers — array of paragraph numbers that the
--      chunk's body spans. Surfaced in retrieval so the model can cite
--      [^n, ¶p] with a real paragraph number.
--
-- Also reserves (but does not populate) a subsequent_treatment JSONB column
-- on each case table. Future extraction passes will fill this with citator
-- data (overruled / distinguished / doubted). Present so the overruled
-- caveat prompt can evolve from "I cannot verify treatment" to flagging
-- known subsequent treatment without requiring another migration.
--
-- This migration is non-destructive: existing case_chunks rows get NULL
-- paragraph_numbers and remain usable. pipeline/backfill_paragraphs.py
-- fills them in on a per-case basis. The retrieval pipeline degrades
-- gracefully when paragraph_numbers is NULL (falls back to plain [^n]).

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. case_paragraphs: every addressable paragraph in every judgment.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS case_paragraphs (
    id SERIAL PRIMARY KEY,
    source_table TEXT NOT NULL CHECK (source_table IN ('supreme_court_cases','high_court_cases')),
    source_id INTEGER NOT NULL,
    -- Paragraph label as it appears in the judgment. String, not int, because
    -- SC judgments use forms like "14", "14.1", "14A", "14(a)".
    paragraph_number TEXT NOT NULL,
    -- Monotonic position within the judgment. Distinct from paragraph_number
    -- because a judgment may contain "14A" before "15" — paragraph_order keeps
    -- the reading sequence unambiguous.
    paragraph_order INTEGER NOT NULL,
    -- Character offsets into the original judgment_text, so we can rehydrate
    -- or highlight later without re-running the extractor.
    start_char INTEGER NOT NULL,
    end_char INTEGER NOT NULL,
    paragraph_text TEXT NOT NULL,
    -- Coarse classifier tag: 'numbered' when a paragraph number was extracted
    -- from the judgment; 'synthetic' when we fell back to sentence-group
    -- paragraphs. Useful for filtering out synthetic paragraphs from
    -- citation pinpoints.
    kind TEXT NOT NULL DEFAULT 'numbered' CHECK (kind IN ('numbered','synthetic')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (source_table, source_id, paragraph_order)
);

CREATE INDEX IF NOT EXISTS idx_case_paragraphs_lookup
    ON case_paragraphs (source_table, source_id, paragraph_number);

CREATE INDEX IF NOT EXISTS idx_case_paragraphs_case
    ON case_paragraphs (source_table, source_id, paragraph_order);

-- ─────────────────────────────────────────────────────────────────
-- 2. case_chunks.paragraph_numbers: paragraphs covered by each chunk.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE case_chunks
    ADD COLUMN IF NOT EXISTS paragraph_numbers TEXT[] NULL;

-- GIN index so retrieval can optionally filter "chunks covering paragraph X".
CREATE INDEX IF NOT EXISTS idx_case_chunks_paragraph_gin
    ON case_chunks USING GIN (paragraph_numbers);

-- ─────────────────────────────────────────────────────────────────
-- 3. Reserved subsequent_treatment column (for future citator data).
-- ─────────────────────────────────────────────────────────────────
-- Shape is intentionally unconstrained (JSONB) — future treatment-extraction
-- pipelines can iterate on schema without migrations.

ALTER TABLE supreme_court_cases
    ADD COLUMN IF NOT EXISTS subsequent_treatment JSONB NULL;

ALTER TABLE high_court_cases
    ADD COLUMN IF NOT EXISTS subsequent_treatment JSONB NULL;

-- ─────────────────────────────────────────────────────────────────
-- 4. Backfill progress table — independent of reembed_progress so the
--    paragraph backfill can be re-run without interfering with the
--    original embedding backfill.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paragraph_backfill_progress (
    source_table TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    paragraphs_inserted INTEGER NOT NULL DEFAULT 0,
    chunks_inserted INTEGER NOT NULL DEFAULT 0,
    extractor_strategy TEXT NOT NULL, -- 'numbered' | 'para_word' | 'synthetic' | 'mixed'
    completed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_table, source_id)
);

COMMIT;
