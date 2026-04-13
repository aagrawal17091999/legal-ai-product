-- Migration 012: drop supreme_court_cases.pdf_url.
--
-- Context: the column was dropped out-of-band on the live DB when SC PDFs
-- moved to on-demand presigning. At retrieval time, src/lib/rag/contextBuilder.ts
-- rebuilds the R2 key from (year, path) and calls getSignedPdfUrl, so the
-- stored URL on the row is no longer read. This migration reconciles
-- schema history with the live DB.
--
-- IF EXISTS makes it idempotent — running it against the already-drifted
-- prod DB is a no-op; running it against a fresh DB bootstrapped from
-- migration 001 drops the column as intended.
--
-- high_court_cases.pdf_url is intentionally left in place: HC still stores
-- absolute PDF URLs and both search.ts and contextBuilder consume them
-- directly.

ALTER TABLE supreme_court_cases DROP COLUMN IF EXISTS pdf_url;
