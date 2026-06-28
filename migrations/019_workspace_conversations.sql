-- Migration 019: Multiple chats per Document Workspace
--
-- Until now a workspace had exactly one linear chat: workspace_messages was
-- keyed only by workspace_id. This adds a conversation layer so a user can run
-- several independent chats over the SAME uploaded documents. Documents and
-- chunks stay workspace-scoped (shared across conversations); only the message
-- history is partitioned by conversation_id.

BEGIN;

CREATE TABLE IF NOT EXISTS workspace_conversations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title        TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ws_conversations_ws
    ON workspace_conversations (workspace_id, updated_at DESC);

ALTER TABLE workspace_messages
    ADD COLUMN IF NOT EXISTS conversation_id UUID
        REFERENCES workspace_conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_ws_messages_conv
    ON workspace_messages (conversation_id, created_at);

-- Backfill: for every workspace that already has messages, create one
-- conversation and attach its existing messages to it, so current single-thread
-- history survives the upgrade. Title it from the first user message.
DO $$
DECLARE
    ws RECORD;
    conv_id UUID;
    first_msg TEXT;
BEGIN
    FOR ws IN
        SELECT DISTINCT workspace_id
          FROM workspace_messages
         WHERE conversation_id IS NULL
    LOOP
        SELECT content INTO first_msg
          FROM workspace_messages
         WHERE workspace_id = ws.workspace_id AND role = 'user'
         ORDER BY created_at ASC
         LIMIT 1;

        INSERT INTO workspace_conversations (workspace_id, title, created_at, updated_at)
        VALUES (
            ws.workspace_id,
            CASE WHEN first_msg IS NULL THEN NULL ELSE LEFT(first_msg, 80) END,
            NOW(), NOW()
        )
        RETURNING id INTO conv_id;

        UPDATE workspace_messages
           SET conversation_id = conv_id
         WHERE workspace_id = ws.workspace_id AND conversation_id IS NULL;
    END LOOP;
END $$;

COMMIT;
