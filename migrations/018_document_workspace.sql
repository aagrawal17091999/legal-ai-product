-- Migration 018: Document Workspace (scoped RAG) + Legal Translation
--
-- Adds two NEW, self-contained feature areas that are fully isolated from the
-- case-law corpus (supreme_court_cases / high_court_cases / case_chunks):
--
--   Feature 1 — Document Workspace: a user uploads documents into a workspace
--   and chats with an AI that answers ONLY from those documents. Each chunk is
--   tagged with workspace_id so retrieval is hard-scoped and can never cross
--   workspaces.
--
--   Feature 2 — Legal Translation: a user uploads a document, the system
--   translates it to a chosen target language and emits a formatted .docx draft.
--   Jobs are tracked here for history / status polling.
--
-- Embeddings are vector(1024) to match the existing voyage-law-2 setup, so the
-- same Voyage helpers and pgvector/HNSW configuration are reused.

BEGIN;

-- ── Feature 1: Document Workspace ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces (user_id, updated_at DESC);

-- One row per uploaded document. status drives the async ingestion lifecycle:
--   pending    → row created, file in R2, not yet processed
--   processing → extraction/OCR/chunk/embed in flight
--   ready      → chunks embedded and searchable
--   failed     → see `error`
CREATE TABLE IF NOT EXISTS workspace_documents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    filename     TEXT NOT NULL,
    mime         TEXT NOT NULL,
    r2_key       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    page_count   INTEGER,
    ocr_used     BOOLEAN NOT NULL DEFAULT FALSE,
    char_count   INTEGER,
    chunk_count  INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_documents_ws
    ON workspace_documents (workspace_id, created_at);

-- Document chunks. Mirror of case_chunks but workspace-scoped. Every retrieval
-- query MUST filter on workspace_id; the btree index makes that scope cheap and
-- the HNSW/GIN indexes serve the vector + FTS lanes within that scope.
CREATE TABLE IF NOT EXISTS document_chunks (
    id           SERIAL PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    document_id  UUID NOT NULL REFERENCES workspace_documents(id) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL,
    page_no      INTEGER,
    chunk_text   TEXT NOT NULL,
    embedding    vector(1024),
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_ws
    ON document_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_doc
    ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding
    ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_document_chunks_fts
    ON document_chunks USING GIN (to_tsvector('english', chunk_text));

-- Chat turns for a workspace. citations holds the DocCitation[] payload (which
-- document + page each grounded statement came from).
CREATE TABLE IF NOT EXISTS workspace_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    citations       JSONB NOT NULL DEFAULT '[]',
    model           TEXT,
    token_usage     JSONB,
    response_time_ms INTEGER,
    status          TEXT NOT NULL DEFAULT 'success',
    error           TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_messages_ws
    ON workspace_messages (workspace_id, created_at);

-- ── Feature 2: Legal Translation ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS translation_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           INTEGER NOT NULL REFERENCES users(id),
    source_filename   TEXT NOT NULL,
    source_mime       TEXT NOT NULL,
    source_r2_key     TEXT NOT NULL,
    target_language   TEXT NOT NULL,
    detected_language TEXT,
    status            TEXT NOT NULL DEFAULT 'processing',
    output_r2_key     TEXT,
    segment_count     INTEGER NOT NULL DEFAULT 0,
    flagged_count     INTEGER NOT NULL DEFAULT 0,
    ocr_used          BOOLEAN NOT NULL DEFAULT FALSE,
    error             TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_translation_jobs_user
    ON translation_jobs (user_id, created_at DESC);

COMMIT;
