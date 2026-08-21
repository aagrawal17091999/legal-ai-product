/**
 * The durable-turn engine.
 *
 * A streamed AI answer used to be owned by the HTTP request that asked for it:
 * the agent's abort signal WAS `request.signal`, so a refresh, a slept laptop
 * or a proxy timeout killed generation mid-sentence. This module owns turns
 * instead, and hands requests a view onto them:
 *
 *   1. The caller writes a `status='pending'` assistant row and calls
 *      `beginTurn`. The row's `content` column is the durable token buffer.
 *   2. The work runs as a floating task. Tokens land in an in-memory buffer AND
 *      are flushed to the row on a timer, so the answer is durable as it grows.
 *   3. Any number of SSE clients subscribe — the original POST, plus any
 *      reattach after a reload. Losing every subscriber changes nothing.
 *   4. Stopping is an explicit act (`requestStop`), never "the socket closed".
 *
 * Two recovery paths cover what the in-memory registry cannot:
 *   - Reattaching to a turn this process doesn't own (after a restart, or on a
 *     second instance) falls back to polling the row — see `attachToTurn`.
 *   - A turn whose process died leaves a `pending` row with a stale heartbeat;
 *     `reapStaleTurns` fails those so they don't spin forever.
 *
 * Feature-specific work — which model runs, how the row is finalized, what
 * bookkeeping follows — belongs in an adapter (lib/chat/turnRunner.ts,
 * lib/docchat/turnRunner.ts). This file knows only about streaming, durability
 * and liveness.
 */
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

/** How often a running turn writes partial content + heartbeat back to its row. */
const FLUSH_INTERVAL_MS = 2000;

/**
 * A pending row untouched for this long belongs to a dead process. Comfortably
 * above FLUSH_INTERVAL_MS so a merely slow flush is never mistaken for a death.
 */
const STALE_TURN_MS = 120_000;

/**
 * Finished turns stay in the registry this long so a client reattaching just
 * after completion still gets the terminal event from memory rather than
 * discovering it via the slower poll fallback.
 */
const FINISHED_RETENTION_MS = 5 * 60_000;

/** Poll interval for the cross-process fallback in `attachToTurn`. */
const FALLBACK_POLL_MS = 500;

export type TurnStatus = "pending" | "success" | "degraded" | "error";

/**
 * Where one feature's assistant rows live, and what its stream calls things.
 *
 * Every field is a compile-time constant from this codebase — they are
 * interpolated into SQL, so they must never come from a request.
 */
export interface TurnTable {
  /** Table holding assistant rows. */
  table: string;
  /** Column scoping a row to one thread (session_id / conversation_id). */
  threadColumn: string;
  /** JSONB column carrying the streamed citation payload. */
  citationsColumn: string;
  /** SSE event name for that payload ("cases" for case law, "citations" for docs). */
  citationsEvent: string;
  /** Written into an abandoned turn that never produced any text. */
  interruptedText: string;
}

type SseEvent = { event: string; data: unknown };

interface Subscriber {
  push: (e: SseEvent) => void;
  close: () => void;
}

export interface LiveTurn {
  readonly messageId: string;
  readonly table: TurnTable;
  /** Everything streamed so far — what a reattaching client diffs against. */
  content: string;
  citations: unknown[];
  /** The one-off "meta" frame, replayed to late subscribers. */
  meta: unknown | null;
  /** Latest status phase, replayed so a reattached client's spinner has words. */
  phase: string | null;
  /** Aborts on an explicit stop, or when the row is found orphaned. */
  readonly signal: AbortSignal;
  /** Emit to every attached client; text events also grow the durable buffer. */
  send(event: string, data: unknown): void;

  /** @internal */
  subscribers: Set<Subscriber>;
  /** @internal */
  abort: AbortController;
  /** @internal */
  terminal: SseEvent | null;
  /** @internal */
  finishedAt: number | null;
  /** @internal */
  flushTimer: ReturnType<typeof setInterval> | null;
  /** @internal */
  lock: { release(): void } | null;
}

const registry = new Map<string, LiveTurn>();

function sweepFinished(): void {
  const now = Date.now();
  for (const [id, turn] of registry) {
    if (turn.finishedAt !== null && now - turn.finishedAt > FINISHED_RETENTION_MS) {
      registry.delete(id);
    }
  }
}

/** Fan an event out to every attached client, dropping any that has gone away. */
function broadcast(turn: LiveTurn, event: string, data: unknown): void {
  for (const sub of turn.subscribers) {
    try {
      sub.push({ event, data });
    } catch {
      turn.subscribers.delete(sub);
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface BeginTurnParams {
  table: TurnTable;
  /** The `pending` row the caller has already inserted. */
  messageId: string;
  /** For diagnostics only. */
  context?: Record<string, unknown>;
  /**
   * A resource whose lifetime is the turn's, not the request's — in practice
   * the connection holding a thread's advisory lock. Released on every exit
   * path, including a crash.
   */
  lock?: { release(): void } | null;
}

/**
 * Register a turn and start its durability loop. The caller then does the work,
 * calling `turn.send(...)` as output arrives, and must finish with `endTurn`.
 */
export function beginTurn(params: BeginTurnParams): LiveTurn {
  const { table, messageId, context, lock } = params;
  const abort = new AbortController();

  const turn: LiveTurn = {
    messageId,
    table,
    content: "",
    citations: [],
    meta: null,
    phase: null,
    signal: abort.signal,
    send(event, data) {
      if (event === "token") {
        this.content += (data as { delta?: string }).delta ?? "";
      } else if (event === "rollback") {
        this.content = "";
      } else if (event === table.citationsEvent) {
        this.citations = (data as unknown[]) ?? [];
      } else if (event === "meta") {
        this.meta = data;
      } else if (event === "status") {
        this.phase = (data as { phase?: string }).phase ?? null;
      }
      broadcast(this, event, data);
    },
    subscribers: new Set(),
    abort,
    terminal: null,
    finishedAt: null,
    flushTimer: null,
    lock: lock ?? null,
  };

  sweepFinished();
  registry.set(messageId, turn);
  turn.flushTimer = setInterval(() => void flush(turn, context), FLUSH_INTERVAL_MS);
  return turn;
}

/**
 * Periodic durability + liveness + the cross-process stop check, all in one
 * round trip. `flushing` keeps a slow write from overlapping the next tick.
 */
const flushing = new WeakSet<LiveTurn>();

async function flush(turn: LiveTurn, context?: Record<string, unknown>): Promise<void> {
  if (flushing.has(turn)) return;
  flushing.add(turn);
  try {
    const { table } = turn;
    const { rows } = await pool.query<{ cancel_requested: boolean }>(
      `UPDATE ${table.table}
          SET content = $1,
              ${table.citationsColumn} = $2,
              live_state = $3,
              heartbeat_at = NOW()
        WHERE id = $4 AND status = 'pending'
      RETURNING cancel_requested`,
      [
        turn.content,
        JSON.stringify(turn.citations),
        JSON.stringify({ phase: turn.phase, meta: turn.meta }),
        turn.messageId,
      ]
    );
    // Row gone or no longer pending: the reaper claimed it, or the thread was
    // deleted. Either way this run is orphaned — stop spending on it.
    if (rows.length === 0) {
      turn.abort.abort();
      return;
    }
    if (rows[0].cancel_requested) turn.abort.abort();
  } catch (err) {
    // A failed flush is not fatal — the answer is still in memory and the
    // adapter's final write is what really matters. Only the heartbeat suffers,
    // and STALE_TURN_MS is generous enough to ride out a blip.
    logError({
      category: "database",
      message: `turn flush failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "warning",
      metadata: { messageId: turn.messageId, ...context },
    });
  } finally {
    flushing.delete(turn);
  }
}

/**
 * Stop the durability loop before the adapter writes the row's final state, so
 * a late flush tick can't overwrite it with a partial snapshot or resurrect
 * `status='pending'`. Call this immediately before finalizing.
 */
export function stopFlushing(turn: LiveTurn): void {
  if (turn.flushTimer) {
    clearInterval(turn.flushTimer);
    turn.flushTimer = null;
  }
}

/**
 * Record the terminal event, replay it to everyone attached, close them out,
 * and release the turn's lock. Safe to call twice.
 */
export function endTurn(turn: LiveTurn, done: Record<string, unknown>): void {
  stopFlushing(turn);
  if (turn.terminal === null) {
    turn.terminal = { event: "done", data: done };
    turn.finishedAt = Date.now();
    for (const sub of turn.subscribers) {
      try {
        sub.push(turn.terminal);
        sub.close();
      } catch {
        /* already gone */
      }
    }
    turn.subscribers.clear();
  }
  releaseTurnLock(turn);
}

/**
 * Release whatever the turn was holding on the caller's behalf (in practice the
 * advisory-lock connection). Idempotent, and called by `endTurn` — adapters
 * call it directly only as a `finally` backstop, so a turn can never end while
 * still holding a lock the next message needs.
 */
export function releaseTurnLock(turn: LiveTurn): void {
  if (!turn.lock) return;
  try {
    turn.lock.release();
  } catch {
    /* already released */
  }
  turn.lock = null;
}

/**
 * Last-resort close-out for a turn whose adapter threw somewhere it shouldn't
 * have. Marks the row failed so it isn't left pending until the reaper's
 * deadline, and releases everyone waiting on it.
 */
export async function abandonTurn(turn: LiveTurn, reason = "interrupted"): Promise<void> {
  stopFlushing(turn);
  await pool
    .query(
      `UPDATE ${turn.table.table}
          SET status = 'error', error = $2, live_state = NULL, heartbeat_at = NULL
        WHERE id = $1 AND status = 'pending'`,
      [turn.messageId, reason]
    )
    .catch(() => {});
  endTurn(turn, {
    message_id: turn.messageId,
    status: "error",
    error: reason,
    content: turn.content,
  });
}

// ---------------------------------------------------------------------------
// Attaching (and reattaching) clients
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function frame(e: SseEvent): Uint8Array {
  return encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

/**
 * Replay what a newly-attached client has missed. `fromOffset` is how many
 * characters of this turn's answer it already has — 0 for the request that
 * started the turn, and the length of the partial row content for a reattach.
 */
function replay(turn: LiveTurn, fromOffset: number, push: (e: SseEvent) => void): void {
  push({ event: "turn", data: { message_id: turn.messageId } });
  if (turn.meta) push({ event: "meta", data: turn.meta });
  if (turn.citations.length > 0) {
    push({ event: turn.table.citationsEvent, data: turn.citations });
  }
  if (turn.phase) push({ event: "status", data: { phase: turn.phase } });
  if (fromOffset > turn.content.length) {
    // The buffer shrank while the client was away — a grounding gate rolled
    // back optimistically-released text. Tell the client to drop what it has
    // and re-send from the top rather than splicing onto stale prose.
    push({ event: "rollback", data: {} });
    if (turn.content) push({ event: "token", data: { delta: turn.content } });
  } else if (turn.content.length > fromOffset) {
    push({ event: "token", data: { delta: turn.content.slice(fromOffset) } });
  }
}

/** SSE stream over a turn this process owns. */
function subscribeStream(turn: LiveTurn, fromOffset: number): ReadableStream<Uint8Array> {
  let sub: Subscriber | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const s: Subscriber = {
        push: (e) => {
          if (closed) return;
          try {
            controller.enqueue(frame(e));
          } catch {
            closed = true;
            turn.subscribers.delete(s);
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      };
      sub = s;

      replay(turn, fromOffset, s.push);

      if (turn.terminal) {
        // Already finished — hand over the outcome and we're done.
        s.push(turn.terminal);
        s.close();
        return;
      }
      turn.subscribers.add(s);
    },
    cancel() {
      // The client went away. That is ALL it means now: detach it and let the
      // turn carry on for its other subscribers — and for the next one to
      // reattach. This is the line that used to cancel the answer.
      if (sub) turn.subscribers.delete(sub);
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SSE stream for a turn this process does NOT own — one started before a
 * restart, or by another instance. There is no in-memory buffer to subscribe
 * to, so poll the row: emit content as it grows, and finish when it leaves
 * 'pending'. Slower than the live path, but a reattach never fails just because
 * the process changed underneath it.
 */
function pollStream(
  table: TurnTable,
  messageId: string,
  fromOffset: number
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let offset = fromOffset;
      const push = (e: SseEvent) => {
        if (closed) return;
        try {
          controller.enqueue(frame(e));
        } catch {
          closed = true;
        }
      };
      push({ event: "turn", data: { message_id: messageId } });

      while (!closed) {
        let row:
          | {
              content: string;
              status: TurnStatus;
              error: string | null;
              citations: unknown[] | null;
              response_time_ms: number | null;
              live_state: { phase?: string } | null;
            }
          | undefined;
        try {
          const { rows } = await pool.query(
            `SELECT content, status, error, response_time_ms, live_state,
                    ${table.citationsColumn} AS citations
               FROM ${table.table} WHERE id = $1`,
            [messageId]
          );
          row = rows[0];
        } catch {
          // Transient DB trouble — the next tick retries.
          await sleep(FALLBACK_POLL_MS);
          continue;
        }

        if (!row) {
          push({
            event: "done",
            data: { message_id: messageId, status: "error", error: "interrupted" },
          });
          break;
        }

        if (row.citations?.length) push({ event: table.citationsEvent, data: row.citations });
        if (row.live_state?.phase) push({ event: "status", data: { phase: row.live_state.phase } });

        if (row.content.length < offset) {
          push({ event: "rollback", data: {} });
          if (row.content) push({ event: "token", data: { delta: row.content } });
          offset = row.content.length;
        } else if (row.content.length > offset) {
          push({ event: "token", data: { delta: row.content.slice(offset) } });
          offset = row.content.length;
        }

        if (row.status !== "pending") {
          push({
            event: "done",
            data: {
              message_id: messageId,
              status: row.status,
              error: row.error,
              response_time_ms: row.response_time_ms,
              content: row.content,
            },
          });
          break;
        }

        await sleep(FALLBACK_POLL_MS);
      }

      if (!closed) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
}

/** Attach to a turn — live if this process owns it, by polling the row if not. */
export function attachToTurn(
  table: TurnTable,
  messageId: string,
  fromOffset: number
): ReadableStream<Uint8Array> {
  sweepFinished();
  const turn = registry.get(messageId);
  if (turn) return subscribeStream(turn, fromOffset);
  return pollStream(table, messageId, fromOffset);
}

/** The live stream for the request that started the turn. */
export function streamNewTurn(messageId: string): ReadableStream<Uint8Array> | null {
  const turn = registry.get(messageId);
  return turn ? subscribeStream(turn, 0) : null;
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

// ---------------------------------------------------------------------------
// Stopping and reaping
// ---------------------------------------------------------------------------

/**
 * Explicit user Stop. Aborts in-process if we own the turn, and always sets the
 * flag so a runner in another process picks it up on its next flush.
 */
export async function requestStop(table: TurnTable, messageId: string): Promise<void> {
  const turn = registry.get(messageId);
  if (turn) turn.abort.abort();
  await pool.query(
    `UPDATE ${table.table} SET cancel_requested = TRUE
      WHERE id = $1 AND status = 'pending'`,
    [messageId]
  );
}

/**
 * Fail turns whose runner died — a deploy, an OOM, a crash — so they don't sit
 * 'pending' forever. Cheap enough to call on every thread load: the partial
 * index means it touches almost nothing. Mirrors how the translate list
 * endpoint fails jobs whose background task vanished.
 */
export async function reapStaleTurns(table: TurnTable, threadId?: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE ${table.table}
        SET status = 'error',
            error = 'interrupted',
            content = CASE WHEN content = '' THEN $1 ELSE content END,
            live_state = NULL,
            heartbeat_at = NULL
      WHERE status = 'pending'
        AND heartbeat_at < NOW() - make_interval(secs => $2::double precision)
        ${threadId ? `AND ${table.threadColumn} = $3` : ""}`,
    threadId
      ? [table.interruptedText, STALE_TURN_MS / 1000, threadId]
      : [table.interruptedText, STALE_TURN_MS / 1000]
  );
  return rowCount ?? 0;
}

/** Test seam: how long a turn may go unflushed before the reaper claims it. */
export const __staleTurnMs = STALE_TURN_MS;
