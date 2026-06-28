-- Migration 020: Chunk character offsets + full document text
--
-- The source panel (CitationPanel) showed retrieval chunks verbatim, so cited
-- passages began and ended mid-sentence: chunks are fixed 2000-char windows with
-- 200-char overlap (src/lib/extract/chunk.ts), and only a chunk's END is snapped
-- to a sentence boundary — its START is just `prevEnd - overlap`, i.e. raw.
--
-- To show whole sentences without changing retrieval, we record each chunk's
-- [start_offset, end_offset) within the flattened document text and keep that
-- full text on the document. At display time we expand a chunk's range outward
-- to the enclosing sentence boundaries (expandToSentences).
--
-- All columns are NULLable: documents ingested before this migration keep
-- working (the panel falls back to rendering chunk_text as before) until they
-- are re-ingested.

BEGIN;

ALTER TABLE document_chunks
    ADD COLUMN IF NOT EXISTS start_offset INTEGER,
    ADD COLUMN IF NOT EXISTS end_offset   INTEGER;

ALTER TABLE workspace_documents
    ADD COLUMN IF NOT EXISTS full_text TEXT;

COMMIT;
