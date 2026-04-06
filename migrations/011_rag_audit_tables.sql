-- Migration 011: per-stage RAG pipeline audit tables.
--
-- Context: chat_messages.rag_trace (migration 010) holds a compact per-message
-- summary. For actual debugging ("why did this answer go wrong?") we want the
-- full per-stage intermediate data, and we want it queryable rather than
-- buried inside a single JSONB blob.
--
-- Two tables, both keyed on chat_messages.id:
--   1) rag_pipeline_steps     — one row per pipeline stage per message.
--   2) rag_query_embeddings   — the actual query-side embedding vectors.
--
-- The query-side embeddings are stored as pgvector so we can later cluster /
-- deduplicate user questions. Retrieved CHUNK embeddings are NOT re-stored
-- here — they already live in case_chunks.embedding.

BEGIN;

CREATE TABLE IF NOT EXISTS rag_pipeline_steps (
    id            BIGSERIAL PRIMARY KEY,
    message_id    UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    step_order    SMALLINT NOT NULL,     -- 1..6, monotonic within a message
    step          TEXT NOT NULL,         -- 'understand' | 'embed_queries' | 'retrieve' | 'rerank' | 'context_build' | 'generate'
    status        TEXT NOT NULL,         -- 'success' | 'error' | 'fallback' | 'skipped'
    duration_ms   INTEGER NOT NULL,
    error         TEXT,
    data          JSONB NOT NULL,        -- step-specific payload (schema documented in src/lib/rag/trace.ts)
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_steps_message
    ON rag_pipeline_steps (message_id, step_order);

CREATE INDEX IF NOT EXISTS idx_rag_steps_step_status
    ON rag_pipeline_steps (step, status);

-- "show me all rerank fallbacks this week"
CREATE INDEX IF NOT EXISTS idx_rag_steps_failures
    ON rag_pipeline_steps (step, created_at DESC)
    WHERE status IN ('error', 'fallback');

CREATE TABLE IF NOT EXISTS rag_query_embeddings (
    id           BIGSERIAL PRIMARY KEY,
    message_id   UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    query_index  SMALLINT NOT NULL,         -- position in the rewritten_queries array
    query_type   TEXT NOT NULL,             -- 'rewritten' | 'hyde'
    query_text   TEXT NOT NULL,
    embedding    vector(1024) NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_qemb_message
    ON rag_query_embeddings (message_id);

COMMIT;
