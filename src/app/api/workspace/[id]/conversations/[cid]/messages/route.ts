import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { requireCredits, OutOfCreditsError } from "@/lib/billing/credits";
import pool from "@/lib/db";
import {
  startDocTurn,
  streamNewTurn,
  reapStaleTurns,
  SSE_HEADERS,
} from "@/lib/docchat/turnRunner";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";

// GET /api/workspace/[id]/conversations/[cid]/messages — message history for one chat
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId, cid: conversationId } = await ctx.params;

    const { rows: convRows } = await pool.query(
      `SELECT 1
         FROM workspace_conversations c
         JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.id = $1 AND c.workspace_id = $2 AND w.user_id = $3`,
      [conversationId, workspaceId, user.id]
    );
    if (convRows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fail any turn whose runner died (deploy, crash) and left the row stuck
    // 'pending' — otherwise the client would reattach to it and spin forever.
    await reapStaleTurns(conversationId).catch(() => 0);

    // A 'pending' assistant row is a turn still being written by a detached
    // runner; the client reattaches to it via the turns/stream endpoint instead
    // of treating it as a finished (empty) answer.
    const { rows } = await pool.query(
      `SELECT id, role, content, citations, status, error, created_at
         FROM workspace_messages
        WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId]
    );
    return NextResponse.json({ messages: rows });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/workspace/[id]/conversations/[cid]/messages
 *
 * Starts a doc-chat turn and streams it. The turn is NOT owned by this request
 * — see lib/docchat/turnRunner.ts. Dropping this connection (refresh, closed
 * laptop, proxy timeout) detaches the client and nothing more; the answer keeps
 * being written into a `status='pending'` row that the client reattaches to via
 * GET .../conversations/[cid]/turns/[mid]/stream.
 *
 * Streams an SSE response (same framing as the case-law chat):
 *   - "turn"      : { message_id } — sent first, before any work, so the client
 *                   can reattach or Stop
 *   - "status"    : { phase: "retrieving" | "reading" | "answering" | "verifying" }
 *   - "token"     : { delta }
 *   - "citations" : DocCitation[]
 *   - "done"      : { message_id, status, error, content } — `status` is
 *                   "success" | "degraded" | "error"; `error` carries the reason
 *                   so the client can show the failure on this very turn
 *   - "error"     : { message }
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });

  try {
    await requireCredits(user.id);
  } catch (e) {
    if (e instanceof OutOfCreditsError) {
      track(EVENTS.OUT_OF_CREDITS, {
        userId: user.id,
        properties: { feature: "workspace_chat", plan: user.plan },
      });
      return NextResponse.json(
        { error: "insufficient_credits", remaining: e.remaining },
        { status: 402 }
      );
    }
    throw e;
  }

  const { id: workspaceId, cid: conversationId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const userMessage: string = body.message;
  if (!userMessage?.trim()) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  // The conversation must exist, belong to this workspace, and be owned by the user.
  const { rows: convRows } = await pool.query(
    `SELECT c.id, c.title
       FROM workspace_conversations c
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = $1 AND c.workspace_id = $2 AND w.user_id = $3`,
    [conversationId, workspaceId, user.id]
  );
  if (convRows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const conversationTitle: string | null = convRows[0].title;

  // Guard: require at least one ready document so we never "answer from nothing".
  const { rows: readyRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM workspace_documents WHERE workspace_id = $1 AND status = 'ready'`,
    [workspaceId]
  );
  if (readyRows[0].n === 0) {
    return NextResponse.json(
      { error: "no_documents", message: "Upload and process at least one document first." },
      { status: 400 }
    );
  }

  // Clear out any turn whose runner died before taking the lock, so a stale
  // 'pending' row can't leave this conversation looking permanently busy.
  await reapStaleTurns(conversationId).catch(() => 0);

  // Serialize turns within a conversation. Two messages fired concurrently
  // (double-click, two tabs) would otherwise both read the same history, both
  // insert a user row, and interleave. A conversation-scoped advisory lock
  // (held on a dedicated connection for the life of the turn) makes the second
  // caller wait its turn. The lock auto-releases if the process is killed.
  const lockClient = await pool.connect();
  let lockHeld = false;
  try {
    const { rows: lockRows } = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [`ws_conversation:${conversationId}`]
    );
    lockHeld = lockRows[0]?.locked === true;
  } catch {
    /* lock probe failed — fall through and release below */
  }
  if (!lockHeld) {
    lockClient.release();
    return NextResponse.json(
      { error: "A message is already being processed in this chat. Please wait." },
      { status: 409 }
    );
  }

  // Ownership of `lockClient` transfers to the runner here: the turn outlives
  // this request, so this request must not release the lock.
  let messageId: string;
  try {
    ({ messageId } = await startDocTurn({
      userId: user.id,
      workspaceId,
      conversationId,
      userMessage,
      needsTitle: !conversationTitle,
      lockClient,
    }));
  } catch (err) {
    lockClient.release();
    logError({
      category: "database",
      message: `failed to start doc chat turn: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "critical",
      userId: user.id,
      endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
      method: "POST",
      metadata: { workspaceId, conversationId },
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
