/**
 * Integration tests for durable chat turns.
 *
 * These are the regression tests for the bug that motivated the design: a page
 * refresh used to cancel the answer, because the agent's abort signal WAS the
 * request's. The interesting assertions here are all about what happens when
 * the client goes away.
 *
 * They need a real Postgres (the runner's durability is Postgres behaviour, not
 * something worth faking), so they self-skip unless TEST_DATABASE_URL is set:
 *
 *   createdb nyaya_turn_test
 *   TEST_DATABASE_URL=postgresql://$USER@localhost:5432/nyaya_turn_test npm test
 *
 * The schema is created and dropped by the test itself.
 */
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL to run durable-turn tests";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, plan TEXT DEFAULT 'free');
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id),
  title TEXT, filters JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL,
  cited_cases JSONB DEFAULT '[]', created_at TIMESTAMP DEFAULT NOW(),
  search_query TEXT, search_results JSONB, context_sent TEXT, model TEXT,
  token_usage JSONB, response_time_ms INTEGER, error TEXT,
  status TEXT DEFAULT 'success', rag_trace JSONB,
  heartbeat_at TIMESTAMP, live_state JSONB,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS idx_chat_messages_pending
  ON chat_messages (session_id, created_at DESC) WHERE status = 'pending';
`;

let pool: Pool;
let runner: typeof import("../turnRunner");

/** What the stubbed agent should do on the next turn. */
let agentScript: (ctl: {
  emit: (delta: string) => void;
  signal: AbortSignal;
}) => Promise<string>;

class FakeAbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AgentAbortedError";
  }
}

before(async () => {
  if (!TEST_DB) return;
  pool = new Pool({ connectionString: TEST_DB });
  await pool.query(SCHEMA);

  // Everything the runner touches beyond Postgres is stubbed: we are testing
  // turn lifecycle and durability, not the agent.
  mock.module("@/lib/db", { defaultExport: pool, namedExports: {} });
  mock.module("@/lib/rag/agent", {
    namedExports: {
      AgentAbortedError: FakeAbortedError,
      buildAgentAuditSteps: () => [],
      runAgent: async (opts: {
        abortSignal?: AbortSignal;
        onTextDelta?: (d: string) => void;
        onStatus?: (s: unknown) => void;
      }) => {
        const text = await agentScript({
          emit: (d) => opts.onTextDelta?.(d),
          signal: opts.abortSignal!,
        });
        return {
          assistantContent: text,
          citedCases: [],
          assembledCases: [],
          model: "test-model",
          tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          stepsUsed: 1,
          stopReason: "end_turn",
          toolTrace: [],
          phaseTrace: [],
          contextDebug: "",
          faithfulness: null,
        };
      },
    },
  });
  mock.module("@/lib/rag/sessionStore", {
    namedExports: {
      hydrateSessionStore: async () => ({ caseSummaries: [], trace: {} }),
    },
  });
  mock.module("@/lib/rag/trace", {
    namedExports: { persistPipelineAudit: async () => {} },
  });
  mock.module("@/lib/claude", {
    namedExports: { generateChatTitle: async () => "A title" },
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
  await pool.query(`DROP TABLE IF EXISTS chat_messages, chat_sessions, users CASCADE`);
  await pool.end();
});

async function newSession() {
  const { rows: [u] } = await pool.query(`INSERT INTO users DEFAULT VALUES RETURNING id, plan`);
  const { rows: [s] } = await pool.query(
    `INSERT INTO chat_sessions (user_id) VALUES ($1) RETURNING id`,
    [u.id]
  );
  return { user: { id: u.id, plan: u.plan }, sessionId: s.id as string };
}

async function start(sessionId: string, user: { id: number; plan: string }) {
  const lockClient = await pool.connect();
  return runner.startTurn({
    // The runner only reads `id`; the wider User shape is irrelevant here.
    user: user as never,
    sessionId,
    userMessage: "what is the law on X?",
    sessionFilters: {},
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
      // Simulate the client walking away mid-answer — the browser closing the
      // connection on a refresh looks exactly like this to the server.
      await reader.cancel();
      return out;
    }
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForRow(id: string, predicate: (r: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(`SELECT * FROM chat_messages WHERE id = $1`, [id]);
    if (rows[0] && predicate(rows[0])) return rows[0];
    await sleep(50);
  }
  throw new Error("timed out waiting for row condition");
}

test(
  "a client that disconnects mid-answer does not cancel the turn",
  { skip },
  async () => {
    const { user, sessionId } = await newSession();
    let released = false;
    agentScript = async ({ emit }) => {
      emit("Part one. ");
      await sleep(150);
      emit("Part two. ");
      await sleep(150);
      emit("Part three.");
      released = true;
      return "Part one. Part two. Part three.";
    };

    const { messageId } = await start(sessionId, user);
    const stream = runner.streamNewTurn(messageId);
    assert.ok(stream);

    // Take the first couple of frames, then hang up — the refresh.
    const seen = await drain(stream, { stopAfter: 2 });
    assert.equal(seen[0][0], "turn");
    assert.equal(seen[0][1].message_id, messageId);

    const row = await waitForRow(messageId, (r) => r.status !== "pending");
    assert.equal(released, true, "the agent ran to completion after the client left");
    assert.equal(row.status, "success");
    assert.equal(row.content, "Part one. Part two. Part three.");
    assert.equal(row.error, null);
    // Terminal turns clear their liveness bookkeeping.
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.live_state, null);
  }
);

test("a reattaching client gets only the text it missed", { skip }, async () => {
  const { user, sessionId } = await newSession();
  let gate: () => void = () => {};
  const held = new Promise<void>((r) => (gate = r));
  agentScript = async ({ emit }) => {
    emit("AAAA");
    await sleep(80);
    emit("BBBB");
    await held;
    emit("CCCC");
    return "AAAABBBBCCCC";
  };

  const { messageId } = await start(sessionId, user);
  const first = runner.streamNewTurn(messageId)!;
  await drain(first, { stopAfter: 3 }); // turn + meta + first token, then leave
  await sleep(150);

  // Reattach claiming the 4 characters of "AAAA" we already rendered.
  const second = runner.attachToTurn(messageId, 4)!;
  const framesPromise = drain(second);
  await sleep(50);
  gate();

  const frames = await framesPromise;
  const tokens = frames.filter(([e]) => e === "token").map(([, d]) => d.delta as string);
  assert.equal(
    tokens.join(""),
    "BBBBCCCC",
    "replay resumed at the offset instead of repeating the whole answer"
  );

  const done = frames.find(([e]) => e === "done");
  assert.ok(done, "the reattached client received the terminal event");
  assert.equal(done![1].status, "success");
  assert.equal(done![1].content, "AAAABBBBCCCC");
});

test("a reattach after a rollback re-sends from the top", { skip }, async () => {
  const { user, sessionId } = await newSession();
  agentScript = async ({ emit }) => {
    emit("final text");
    await sleep(50);
    return "final text";
  };
  const { messageId } = await start(sessionId, user);
  await waitForRow(messageId, (r) => r.status !== "pending");

  // Claim a longer offset than the turn ever produced — what a client holding
  // rolled-back text looks like. It must be told to drop what it has.
  const frames = await drain(runner.attachToTurn(messageId, 9999)!);
  const events = frames.map(([e]) => e);
  assert.ok(events.includes("rollback"), "client was told to discard stale text");
  const tokens = frames.filter(([e]) => e === "token").map(([, d]) => d.delta as string);
  assert.equal(tokens.join(""), "final text");
});

test("Stop cancels the turn and records it as cancelled, not failed", { skip }, async () => {
  const { user, sessionId } = await newSession();
  agentScript = async ({ emit, signal }) => {
    emit("Half an answer");
    for (let i = 0; i < 100; i++) {
      if (signal.aborted) throw new FakeAbortedError();
      await sleep(25);
    }
    return "should never get here";
  };

  const { messageId } = await start(sessionId, user);
  const frames = drain(runner.streamNewTurn(messageId)!);
  await sleep(120);
  await runner.requestStop(messageId);

  const done = (await frames).find(([e]) => e === "done");
  assert.ok(done);
  assert.equal(done![1].status, "error");
  assert.equal(done![1].error, "cancelled", "a stop is the sentinel, not a real failure");

  const row = await waitForRow(messageId, (r) => r.status !== "pending");
  assert.equal(row.error, "cancelled");
  assert.equal(row.content, "Half an answer", "partial text written before Stop is kept");
});

test("the reaper fails abandoned turns and leaves live ones alone", { skip }, async () => {
  const { sessionId } = await newSession();
  const { rows: [live] } = await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, status, heartbeat_at)
     VALUES ($1,'assistant','partial','pending', NOW()) RETURNING id`,
    [sessionId]
  );
  const { rows: [dead] } = await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, status, heartbeat_at)
     VALUES ($1,'assistant','','pending', NOW() - INTERVAL '10 minutes') RETURNING id`,
    [sessionId]
  );

  const reaped = await runner.reapStaleTurns(sessionId);
  assert.equal(reaped, 1);

  const { rows } = await pool.query(
    `SELECT id, status, error, content FROM chat_messages WHERE id = ANY($1)`,
    [[live.id, dead.id]]
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[live.id].status, "pending", "a turn still heartbeating is untouched");
  assert.equal(byId[dead.id].status, "error");
  assert.equal(byId[dead.id].error, "interrupted");
  assert.match(byId[dead.id].content, /interrupted/i);
});

test("history for the next turn skips a half-written pending row", { skip }, async () => {
  const { user, sessionId } = await newSession();
  // An orphan from a crashed process, never reaped.
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, status, heartbeat_at)
     VALUES ($1,'assistant','half a thought','pending', NOW())`,
    [sessionId]
  );

  agentScript = async ({ emit }) => {
    emit("fresh answer");
    return "fresh answer";
  };

  const { messageId } = await start(sessionId, user);
  const row = await waitForRow(messageId, (r) => r.status !== "pending");
  assert.equal(row.status, "success");
  assert.equal(row.content, "fresh answer");

  // The orphan is still there, still pending — untouched by the new turn, and
  // left for the reaper rather than fed to the model as conversation history.
  const { rows } = await pool.query(
    `SELECT content FROM chat_messages WHERE session_id = $1 AND status = 'pending'`,
    [sessionId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "half a thought");
});
