-- Migration 038: one case_chunks partition per court.
--
-- Supreme Court and High Court chunks shared one table and one HNSW index.
-- pgvector 0.6 has no iterative index scans: a Supreme Court vector query
-- takes the hnsw.ef_search (60) nearest chunks of ANY court and only then
-- drops the High Court ones, so as High Court data grew, Supreme Court
-- searches would have returned fewer results even with HC search switched
-- off. After this migration case_chunks is LIST-partitioned on source_table:
--
--   case_chunks_sc  the existing table, renamed, with its existing indexes
--                   (HNSW, FTS, ...) untouched — nothing is rebuilt
--   case_chunks_hc  High Court chunks, with lookup indexes only
--
-- Every app query filters on a literal source_table, so Postgres prunes to
-- one partition at plan time: Supreme Court queries run against exactly the
-- table and index they used before High Court data existed, and loading
-- High Court data never touches them. Queries and INSERTs keep using the name
-- case_chunks; no code change is needed.
--
-- case_chunks_hc deliberately has NO vector or full-text index yet: High
-- Court search is off (HC_SEARCH_ENABLED), ingestion doesn't need them, and
-- maintaining an HNSW graph during a bulk load would compete with the
-- Supreme Court index for RAM. Build them once, before switching High Court
-- search on — see pipeline/HC_INGEST.md, "Before enabling High Court search".
--
-- Run with High Court ingestion stopped: until step 3 commits, new High
-- Court chunks are rejected by the Supreme-Court-only CHECK. Supreme Court
-- writes (sync_sc) are unaffected throughout. Each step is guarded, so a
-- re-run after a failure (e.g. a lock_timeout in step 3) resumes safely.

-- Never queue behind a long query holding case_chunks: fail and retry instead,
-- so live searches aren't stuck waiting behind this migration's lock.
SET lock_timeout = '10s';

-- 1. Move the High Court rows out and pin the old table to Supreme Court.
BEGIN;
CREATE TABLE IF NOT EXISTS case_chunks_hc (LIKE case_chunks INCLUDING DEFAULTS);
DO $$
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.case_chunks'::regclass) = 'r' THEN
    INSERT INTO case_chunks_hc SELECT * FROM case_chunks WHERE source_table = 'high_court_cases';
    DELETE FROM case_chunks WHERE source_table = 'high_court_cases';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_chunks_sc_only') THEN
      ALTER TABLE case_chunks ADD CONSTRAINT case_chunks_sc_only
        CHECK (source_table = 'supreme_court_cases') NOT VALID;
    END IF;
  END IF;
END $$;
COMMIT;

-- 2. Validate the CHECK. This scans the table but takes only a SHARE UPDATE
-- EXCLUSIVE lock, so searches and Supreme Court inserts carry on. A valid
-- CHECK lets step 3's ATTACH skip its own scan and hold its lock only briefly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_chunks_sc_only' AND NOT convalidated) THEN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT case_chunks_sc_only',
                   (SELECT conrelid::regclass FROM pg_constraint WHERE conname = 'case_chunks_sc_only'));
  END IF;
END $$;

-- 3. Swap in the partitioned parent. Brief ACCESS EXCLUSIVE locks only.
BEGIN;
DO $$
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.case_chunks'::regclass) = 'r' THEN
    ALTER TABLE case_chunks RENAME TO case_chunks_sc;
    CREATE TABLE case_chunks (LIKE case_chunks_sc INCLUDING DEFAULTS) PARTITION BY LIST (source_table);
    ALTER SEQUENCE case_chunks_id_seq OWNED BY case_chunks.id;
    ALTER TABLE case_chunks ATTACH PARTITION case_chunks_sc FOR VALUES IN ('supreme_court_cases');
    ALTER TABLE case_chunks ATTACH PARTITION case_chunks_hc FOR VALUES IN ('high_court_cases');
  END IF;
END $$;
COMMIT;

-- 4. Lookup indexes on the High Court partition: chunk ids, per-case
-- replace/delete and the ingest dedup check, paragraph pinpoints.
CREATE UNIQUE INDEX IF NOT EXISTS case_chunks_hc_pkey ON case_chunks_hc (id);
CREATE INDEX IF NOT EXISTS idx_chunks_hc_source ON case_chunks_hc (source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_case_chunks_hc_paragraph_gin ON case_chunks_hc USING gin (paragraph_numbers);
