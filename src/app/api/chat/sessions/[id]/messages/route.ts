import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { requireCredits, OutOfCreditsError } from "@/lib/billing/credits";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import pool from "@/lib/db";
import {
  startTurn,
  streamNewTurn,
  reapStaleTurns,
  SSE_HEADERS,
} from "@/lib/chat/turnRunner";
import { logError } from "@/lib/error-logger";
import type { SearchFilters } from "@/types";

/**
 * POST /api/chat/sessions/[id]/messages
 *
 * Starts a research turn and streams it. The turn itself is NOT owned by this
 * request — see lib/chat/turnRunner.ts. Dropping this connection (refresh,
 * closed laptop, proxy timeout) detaches the client and nothing more; the
 * answer keeps being written into a `status='pending'` row that the client
 * reattaches to via GET /api/chat/sessions/[id]/turns/[mid]/stream.
 *
 * SSE event types:
 *   - "turn"   : { message_id } — sent first, before any work. The client needs
 *                the real row id up front so it can reattach or Stop.
 *   - "meta"   : { mode, model, session_cases_count, session_store, history_turns }
 *   - "tool"   : { phase, tool, input, step_index, status?, duration_ms?, error?, data? }
 *                — phase ∈ "start" | "end"
 *   - "cases"  : CitedCase[] — re-emitted whenever the registry grows
 *   - "token"  : { delta: string } — incremental text from the model
 *   - "rollback": {} — drop rendered text; the grounding gate retracted it
 *   - "title"  : { title: string } — session title (first message only)
 *   - "done"   : { message_id, status, error, response_time_ms, steps_used,
 *                  stop_reason, content } — `status` is "success" | "degraded" |
 *                  "error"; `error` carries the reason when it isn't "success",
 *                  so the client can render the failed turn without a reload
 *   - "error"  : { message: string }
 *
 * Non-stream errors (auth, limits, validation, session ownership) are returned
 * as normal JSON responses with proper HTTP status codes.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });

  // Gate on the credit wallet: allow the question through while any balance
  // remains (it may overshoot one action); block once exhausted.
  try {
    await requireCredits(user.id);
  } catch (e) {
    if (e instanceof OutOfCreditsError) {
      track(EVENTS.OUT_OF_CREDITS, {
        userId: user.id,
        properties: { feature: "chat", plan: user.plan },
      });
      return NextResponse.json(
        { error: "insufficient_credits", remaining: e.remaining },
        { status: 402 }
      );
    }
    throw e;
  }

  const { id: sessionId } = await params;
  const body = await request.json();
  const userMessage: string = body.message;

  if (!userMessage?.trim()) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const { rows: sessionRows } = await pool.query(
    `SELECT id, filters FROM chat_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, user.id]
  );
  if (sessionRows.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const sessionFilters: SearchFilters = sessionRows[0].filters || {};

  // Clear out any turn whose runner died (deploy, crash) before taking the lock,
  // so a stale 'pending' row can't leave this session looking permanently busy.
  await reapStaleTurns(sessionId).catch(() => 0);

  // Serialize turns within a single session. Two messages fired concurrently
  // (double-click, two tabs) would otherwise both read the same history, both
  // insert a user row, and interleave — corrupting message order and possibly
  // double-titling/double-charging. A session-scoped advisory lock (held on a
  // dedicated connection for the life of the turn) makes the second caller wait
  // its turn instead. The lock auto-releases if the function is killed.
  const lockClient = await pool.connect();
  let lockHeld = false;
  try {
    const { rows: lockRows } = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [`chat_session:${sessionId}`]
    );
    lockHeld = lockRows[0]?.locked === true;
  } catch {
    /* lock probe failed — fall through and release below */
  }
  if (!lockHeld) {
    lockClient.release();
    return NextResponse.json(
      { error: "A message is already being processed in this conversation. Please wait." },
      { status: 409 }
    );
  }

  // Ownership of `lockClient` transfers to the runner here: the turn outlives
  // this request, so this request must not release the lock. startTurn's runner
  // releases it on every exit path.
  let messageId: string;
  try {
    ({ messageId } = await startTurn({
      user,
      sessionId,
      userMessage,
      sessionFilters,
      lockClient,
    }));
  } catch (err) {
    lockClient.release();
    logError({
      category: "database",
      message: `failed to start chat turn: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "critical",
      userId: user.id,
      endpoint: "/api/chat/sessions/[id]/messages",
      method: "POST",
      metadata: { sessionId },
    });
    return NextResponse.json(
      { error: "Couldn't start this answer. Please try again." },
      { status: 500 }
    );
  }

  const stream = streamNewTurn(messageId);
  if (!stream) {
    // The turn finished (or was evicted) between starting and subscribing —
    // vanishingly unlikely, but the client can just read the row.
    return NextResponse.json({ message_id: messageId, streaming: false });
  }

  return new Response(stream, { headers: SSE_HEADERS });
}
