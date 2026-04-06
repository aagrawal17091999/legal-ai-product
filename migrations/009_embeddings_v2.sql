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

-- Drop the HNSW index before touching the column (type change would invalidate it anyway).
DROP INDEX IF EXISTS idx_chunks_embedding;

-- Wipe existing chunks. They were produced by a different model + dimension
-- and cannot be mixed with voyage-law-2 1024d vectors.
TRUNCATE TABLE case_chunks RESTART IDENTITY;

-- Ensure the column is exactly vector(1024). ALTER is a no-op if already correct,
-- but we re-declare to be explicit and to survive environments where the type
-- drifted.
ALTER TABLE case_chunks ALTER COLUMN embedding TYPE vector(1024);

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
