-- Migration 009: rebuild case_chunks embeddings at vector(1024) for voyage-law-2
--
-- Context: src/lib/voyage.ts was hardcoded to output_dimension=512 while the
-- column was declared vector(1024) and the Python pipeline omitted the dim
-- parameter entirely. Runtime query embeddings and stored chunk embeddings
-- were therefore inconsistent. We also upgrade to voyage-law-2 (legal-domain
-- specialized, 1024d) for materially better retrieval on Indian case law.
--
-- This migration is destructive for case_chunks. After running it, the entire
-- corpus must be re-embedded via pipeline/reembed_all.py before chat or
-- vector search is usable.

BEGIN;

-- GUARDED + IDEMPOTENT. The original purpose was to wipe legacy embeddings made
-- at the wrong dimension/model (512d / unspecified) so they couldn't be mixed
-- with voyage-law-2 1024d vectors. We ONLY do that destructive step when the
-- column is not already vector(1024). Once it is, re-running this migration must
-- NEVER truncate populated data — an unconditional TRUNCATE here previously cost
-- a full (paid) re-embed of the whole corpus.
DO $$
DECLARE
  current_mod integer;
BEGIN
  SELECT atttypmod INTO current_mod
    FROM pg_attribute
   WHERE attrelid = 'case_chunks'::regclass
     AND attname = 'embedding'
     AND NOT attisdropped;

  IF current_mod IS DISTINCT FROM 1024 THEN
    RAISE NOTICE 'case_chunks.embedding is not vector(1024) (typmod=%); wiping and retyping legacy embeddings.', current_mod;
    DROP INDEX IF EXISTS idx_chunks_embedding;
    TRUNCATE TABLE case_chunks RESTART IDENTITY;
    ALTER TABLE case_chunks ALTER COLUMN embedding TYPE vector(1024);
  ELSE
    RAISE NOTICE 'case_chunks.embedding already vector(1024); leaving existing data intact (no truncate).';
  END IF;
END $$;

-- Progress table for resumable re-embed. Keyed on the case, not the chunk,
-- so pipeline/reembed_all.py can skip cases it has already processed.
CREATE TABLE IF NOT EXISTS reembed_progress (
    source_table TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    chunks_inserted INTEGER NOT NULL DEFAULT 0,
    completed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_table, source_id)
);

COMMIT;

-- Recreate the HNSW index outside the transaction (HNSW builds can be slow;
-- keeping it out of the txn avoids long locks in environments with existing
-- data, though after TRUNCATE this is instant).
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON case_chunks USING hnsw (embedding vector_cosine_ops);

-- FTS index on chunk_text. The new RAG pipeline retrieves at chunk
-- granularity (not case granularity) so that full-text matches and vector
-- matches can be fused via RRF on the same keys.
CREATE INDEX IF NOT EXISTS idx_chunks_text_fts
    ON case_chunks USING GIN (to_tsvector('english', chunk_text));
