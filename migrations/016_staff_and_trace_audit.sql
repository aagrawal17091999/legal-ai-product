-- Migration 016: staff flag + trace access audit.
--
-- Motivation:
--   1. The /trace/[messageId] debug page exposes internal pipeline details
--      (tool calls, rerank scores, model name). It should be visible to
--      internal staff only, not end users. `users.is_staff` is the gate.
--   2. Every read of a trace is logged to `trace_access_log` so we can see
--      who is actually using the debug surface and — if misuse were ever
--      suspected — prove scope compliance.
--
-- To promote a user to staff after deploying this migration:
--   UPDATE users SET is_staff = TRUE WHERE email = 'anshdoesanalytics@gmail.com';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS trace_access_log (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL,
    -- The message_id may or may not still exist when we query the log
    -- (retention cron can delete chat_messages); keeping this as a plain UUID
    -- (not an FK) lets the audit survive cascading deletes.
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trace_access_log_user_id_idx
    ON trace_access_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trace_access_log_message_id_idx
    ON trace_access_log (message_id);
