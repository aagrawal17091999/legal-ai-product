import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { attachToTurn, reapStaleTurns, SSE_HEADERS } from "@/lib/chat/turnRunner";

/**
 * GET /api/chat/sessions/[id]/turns/[mid]/stream?offset=N
 *
 * Reattach to a turn that is still being written. This is what makes a refresh
 * (or a closed laptop, or a dropped connection) a non-event: the client finds a
 * `status='pending'` assistant row when it loads the session and picks the
 * stream back up here.
 *
 * `offset` is how many characters of the answer the client already has, so the
 * server sends only what it missed. It emits the same SSE vocabulary as the
 * POST that started the turn, so the client parses one format either way.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  const { id: sessionId, mid } = await params;

  // Ownership: the message must be an assistant row in a session this user
  // owns. Joining rules out reading someone else's turn by guessing an id.
  const { rows } = await pool.query<{ status: string; content: string }>(
    `SELECT m.status, m.content
       FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.id = $1 AND m.session_id = $2 AND s.user_id = $3
        AND m.role = 'assistant'`,
    [mid, sessionId, user.id]
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "Turn not found" }, { status: 404 });
  }

  // A turn already finished needs no stream — the row the client just loaded is
  // the whole answer.
  if (rows[0].status !== "pending") {
    return NextResponse.json({ status: rows[0].status, streaming: false });
  }

  // Pending but abandoned by a dead process: fail it now rather than handing
  // the client a stream that would poll until the reaper's own deadline.
  const reaped = await reapStaleTurns(sessionId).catch(() => 0);
  if (reaped > 0) {
    const { rows: after } = await pool.query<{ status: string }>(
      `SELECT status FROM chat_messages WHERE id = $1`,
      [mid]
    );
    if (after[0]?.status !== "pending") {
      return NextResponse.json({ status: after[0]?.status ?? "error", streaming: false });
    }
  }

  const rawOffset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const stream = attachToTurn(mid, offset);
  if (!stream) {
    return NextResponse.json({ status: "error", streaming: false });
  }
  return new Response(stream, { headers: SSE_HEADERS });
}
