-- Migration 010: add rag_trace column for debugging the new RAG pipeline.
--
-- The new chat flow (query-understanding -> hybrid retrieve -> rerank ->
-- context build -> stream) has enough moving parts that we want a single
-- JSONB blob per message that captures: rewritten queries, implicit filters,
-- candidate chunk ids + rrf scores, final reranked chunk ids + scores, and
-- per-stage timings. This is independent of the existing tracing columns
-- (search_query, search_results, context_sent, token_usage, response_time_ms)
-- which remain populated as before.

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS rag_trace JSONB;
