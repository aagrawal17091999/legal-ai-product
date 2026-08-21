-- Migration 030: make a chat turn survive the request that started it.
--
-- Before this, the agent ran inside the POST response stream and was killed by
-- `request.signal` the moment the client went away — a page refresh, a closed
-- laptop, a proxy timeout all landed as `status='error', error='cancelled'`.
-- The turn now runs detached from the request and streams into the assistant
-- row itself, so a reconnecting client can pick it back up.
--
-- The assistant row is inserted up front with status='pending' and its `content`
-- column IS the durable token buffer: the runner appends to it as the answer is
-- written, and a client that reattaches asks for everything past the offset it
-- already has.

-- `status` is a plain TEXT column (migration 007) with no CHECK constraint, so
-- 'pending' needs no type change. Documented here because nothing else says it:
--   'pending'  — the turn is still running somewhere; content is partial.
--   'success' / 'degraded' / 'error' — terminal, as before.

-- Last time the runner touched this turn. A row still 'pending' with a stale
-- heartbeat belongs to a process that died (deploy, OOM, crash); the reaper in
-- lib/chat/turnRunner.ts fails those instead of leaving them spinning forever.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP;

-- Non-token stream state a reattaching client needs to rebuild the live UI:
-- { meta, phase, started_at }. Cases live in `cited_cases`, which is already
-- flushed incrementally, so they are not duplicated here.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS live_state JSONB;

-- Set by the Stop button (or by a stop from another tab / another instance).
-- The runner reads it back on each heartbeat flush and aborts the agent, which
-- is what makes Stop work across processes now that it is no longer just
-- "close the HTTP connection".
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

-- Finding the in-flight turn for a session is on the hot path for every session
-- load and every reattach. Partial index — pending rows are a vanishing
-- fraction of the table.
CREATE INDEX IF NOT EXISTS idx_chat_messages_pending
    ON chat_messages (session_id, created_at DESC)
    WHERE status = 'pending';

-- The reaper scans by heartbeat across all sessions.
CREATE INDEX IF NOT EXISTS idx_chat_messages_pending_heartbeat
    ON chat_messages (heartbeat_at)
    WHERE status = 'pending';
