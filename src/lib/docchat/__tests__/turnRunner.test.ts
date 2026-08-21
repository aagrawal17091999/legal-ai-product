/**
 * Integration tests for durable document-chat turns.
 *
 * The mirror of lib/chat/__tests__/turnRunner.test.ts, and deliberately so:
 * both features run on the same engine (lib/turns/durableTurns.ts), so running
 * the same scenarios through the second adapter is what proves the engine is
 * genuinely shared rather than accidentally chat-shaped.
 *
 * Needs a real Postgres — durability is Postgres behaviour, not something worth
 * faking — so these self-skip unless TEST_DATABASE_URL is set:
 *
 *   createdb nyaya_turn_test
 *   TEST_DATABASE_URL=postgresql://$USER@localhost:5432/nyaya_turn_test npm test
 */
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL to run durable-turn tests";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER,
  updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS workspace_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS workspace_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES workspace_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]', model TEXT, token_usage JSONB,
  response_time_ms INTEGER, status TEXT NOT NULL DEFAULT 'success', error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMP, live_state JSONB,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS idx_ws_messages_pending
  ON workspace_messages (conversation_id, created_at DESC) WHERE status = 'pending';
`;

let pool: Pool;
let runner: typeof import("../turnRunner");

/** What the stubbed doc agent should do on the next turn. */
let docScript: (ctl: {
  emit: (delta: string) => void;
  signal: AbortSignal;
}) => Promise<string>;

class FakeDocAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "DocAgentAbortedError";
  }
}

before(async () => {
  if (!TEST_DB) return;
  pool = new Pool({ connectionString: TEST_DB });
  await pool.query(SCHEMA);

  mock.module("@/lib/db", { defaultExport: pool, namedExports: {} });
  mock.module("@/lib/docchat/docAgent", {
    namedExports: { DocAgentAbortedError: FakeDocAborted },
  });
  mock.module("@/lib/docchat/answer", {
    namedExports: {
      runDocChat: async (opts: {
        abortSignal?: AbortSignal;
        onTextDelta?: (d: string) => void;
      }) => {
        const text = await docScript({
          emit: (d) => opts.onTextDelta?.(d),
          signal: opts.abortSignal!,
        });
        return {
          assistantContent: text,
          citations: [{ ref: 1, chunk_id: "c1", document_id: "d1" }],
          model: "test-model",
          tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          retrievedCount: 1,
          topScore: 1,
          groundedFromContext: true,
          mode: "agent",
          budgetHit: false,
          creditBudget: 0,
        };
      },
    },
  });
  mock.module("@/lib/billing/meter", {
    namedExports: {
      withMeter: async (_ctx: unknown, fn: () => Promise<unknown>) => ({
        result: await fn(),
        meter: { credits: 0 },
      }),
      markMeterUnbillable: () => {},
    },
  });
  mock.module("@/lib/analytics/server", { namedExports: { track: () => {} } });
  mock.module("@/lib/error-logger", { namedExports: { logError: () => {} } });

  runner = await import("../turnRunner");
});

after(async () => {
  if (!TEST_DB) return;
  await pool.query(
    `DROP TABLE IF EXISTS workspace_messages, workspace_conversations, workspaces CASCADE`
  );
  await pool.end();
});

async function newConversation() {
  const { rows: [w] } = await pool.query(
    `INSERT INTO workspaces (user_id) VALUES (1) RETURNING id`
  );
  const { rows: [c] } = await pool.query(
    `INSERT INTO workspace_conversations (workspace_id) VALUES ($1) RETURNING id`,
    [w.id]
  );
  return { workspaceId: w.id as string, conversationId: c.id as string };
}

async function start(workspaceId: string, conversationId: string) {
  const lockClient = await pool.connect();
  return runner.startDocTurn({
    userId: 1,
    workspaceId,
    conversationId,
    userMessage: "what does the contract say about termination?",
    needsTitle: true,
    lockClient,
  });
}

/** Read an SSE stream into a list of [event, data] pairs. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  opts: { stopAfter?: number } = {}
): Promise<Array<[string, Record<string, unknown>]>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const out: Array<[string, Record<string, unknown>]> = [];
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) out.push([ev, JSON.parse(data.join("\n"))]);
    }
    if (opts.stopAfter && out.length >= opts.stopAfter) {
      // Simulate the client walking away mid-answer — a refresh looks exactly
      // like this to the server.
      await reader.cancel();
      return out;
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRow(id: string, predicate: (r: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(`SELECT * FROM workspace_messages WHERE id = $1`, [id]);
    if (rows[0] && predicate(rows[0])) return rows[0];
    await sleep(50);
  }
  throw new Error("timed out waiting for row condition");
}

test("a disconnecting client does not cancel a doc-chat turn", { skip }, async () => {
  const { workspaceId, conversationId } = await newConversation();
  let finished = false;
  docScript = async ({ emit }) => {
    emit("The contract says ");
    await sleep(150);
    emit("either party may terminate.");
    finished = true;
    return "The contract says either party may terminate.";
  };

  const { messageId } = await start(workspaceId, conversationId);
  const seen = await drain(runner.streamNewTurn(messageId)!, { stopAfter: 2 });
  assert.equal(seen[0][0], "turn");
  assert.equal(seen[0][1].message_id, messageId);

  const row = await waitForRow(messageId, (r) => r.status !== "pending");
  assert.equal(finished, true, "the agent ran to completion after the client left");
  assert.equal(row.status, "success");
  assert.equal(row.content, "The contract says either party may terminate.");
  assert.equal(row.heartbeat_at, null);
  assert.equal(row.live_state, null);
});

test("a reattaching doc-chat client gets only the text it missed", { skip }, async () => {
  const { workspaceId, conversationId } = await newConversation();
  let gate: () => void = () => {};
  const held = new Promise<void>((r) => (gate = r));
  docScript = async ({ emit }) => {
    emit("AAAA");
    await sleep(80);
    emit("BBBB");
    await held;
    emit("CCCC");
    return "AAAABBBBCCCC";
  };

  const { messageId } = await start(workspaceId, conversationId);
  await drain(runner.streamNewTurn(messageId)!, { stopAfter: 2 });
  await sleep(150);

  const frames = drain(runner.attachToTurn(messageId, 4));
  await sleep(50);
  gate();

  const seen = await frames;
  const tokens = seen.filter(([e]) => e === "token").map(([, d]) => d.delta as string);
  assert.equal(tokens.join(""), "BBBBCCCC", "replay resumed at the offset");

  const done = seen.find(([e]) => e === "done");
  assert.ok(done, "the reattached client received the terminal event");
  assert.equal(done![1].status, "success");
  assert.equal(done![1].content, "AAAABBBBCCCC");

  // The engine is parameterized per feature: doc chat's payload arrives as
  // "citations", not case-law chat's "cases".
  assert.ok(seen.some(([e]) => e === "citations"), "citations use this feature's event name");
});

test("Stop cancels a doc-chat turn and records it as cancelled", { skip }, async () => {
  const { workspaceId, conversationId } = await newConversation();
  docScript = async ({ emit, signal }) => {
    emit("Half an answer");
    for (let i = 0; i < 100; i++) {
      if (signal.aborted) throw new FakeDocAborted();
      await sleep(25);
    }
    return "should never get here";
  };

  const { messageId } = await start(workspaceId, conversationId);
  const frames = drain(runner.streamNewTurn(messageId)!);
  await sleep(120);
  await runner.requestStop(messageId);

  const done = (await frames).find(([e]) => e === "done");
  assert.ok(done);
  assert.equal(done![1].error, "cancelled", "a stop is the sentinel, not a real failure");

  const row = await waitForRow(messageId, (r) => r.status !== "pending");
  assert.equal(row.error, "cancelled");
  assert.equal(row.content, "Half an answer", "partial text written before Stop is kept");
});

test("the doc-chat reaper fails abandoned turns only", { skip }, async () => {
  const { workspaceId, conversationId } = await newConversation();
  const { rows: [live] } = await pool.query(
    `INSERT INTO workspace_messages (workspace_id, conversation_id, role, content, status, heartbeat_at)
     VALUES ($1,$2,'assistant','partial','pending', NOW()) RETURNING id`,
    [workspaceId, conversationId]
  );
  const { rows: [dead] } = await pool.query(
    `INSERT INTO workspace_messages (workspace_id, conversation_id, role, content, status, heartbeat_at)
     VALUES ($1,$2,'assistant','','pending', NOW() - INTERVAL '10 minutes') RETURNING id`,
    [workspaceId, conversationId]
  );

  assert.equal(await runner.reapStaleTurns(conversationId), 1);

  const { rows } = await pool.query(
    `SELECT id, status, error, content FROM workspace_messages WHERE id = ANY($1)`,
    [[live.id, dead.id]]
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[live.id].status, "pending", "a turn still heartbeating is untouched");
  assert.equal(byId[dead.id].status, "error");
  assert.equal(byId[dead.id].error, "interrupted");
  assert.match(byId[dead.id].content, /interrupted/i);
});

test("a completed turn titles its conversation and bumps the workspace", { skip }, async () => {
  const { workspaceId, conversationId } = await newConversation();
  docScript = async ({ emit }) => {
    emit("Answered.");
    return "Answered.";
  };

  const { messageId } = await start(workspaceId, conversationId);
  await waitForRow(messageId, (r) => r.status !== "pending");

  const { rows } = await pool.query(
    `SELECT title FROM workspace_conversations WHERE id = $1`,
    [conversationId]
  );
  assert.equal(rows[0].title, "what does the contract say about termination?");
});
