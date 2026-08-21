-- Migration 032: durable turns for document chat.
--
-- The same treatment migration 030 gave case-law chat. Doc chat's symptom was
-- milder — its route never passed `request.signal` to the model, so a refresh
-- preserved the answer and merely lost the live stream until a reload — but the
-- turn was still owned by the request, which meant no way to watch it finish,
-- no Stop, and no recovery when a proxy timed the connection out mid-answer.
--
-- Both features now run on lib/turns/durableTurns.ts, which expects these three
-- columns on whichever table holds the assistant rows. See migration 030 for
-- what each is for; the semantics are identical here.

-- 'pending' joins 'success' / 'degraded' / 'error' on this column. It is plain
-- TEXT with no CHECK constraint, so no type change is needed.
ALTER TABLE workspace_messages ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP;
ALTER TABLE workspace_messages ADD COLUMN IF NOT EXISTS live_state JSONB;
ALTER TABLE workspace_messages
    ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

-- Finding the in-flight turn for a conversation is on the hot path for every
-- conversation load and every reattach.
CREATE INDEX IF NOT EXISTS idx_ws_messages_pending
    ON workspace_messages (conversation_id, created_at DESC)
    WHERE status = 'pending';

-- The reaper scans by heartbeat across all conversations.
CREATE INDEX IF NOT EXISTS idx_ws_messages_pending_heartbeat
    ON workspace_messages (heartbeat_at)
    WHERE status = 'pending';
