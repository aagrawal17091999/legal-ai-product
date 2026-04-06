-- Add tracing columns to chat_messages for full observability
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS search_query TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS search_results JSONB;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS context_sent TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS token_usage JSONB;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS response_time_ms INTEGER;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'success';
