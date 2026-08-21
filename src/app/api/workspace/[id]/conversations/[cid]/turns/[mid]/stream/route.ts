import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { attachToTurn, reapStaleTurns, SSE_HEADERS } from "@/lib/docchat/turnRunner";

/**
 * GET /api/workspace/[id]/conversations/[cid]/turns/[mid]/stream?offset=N
 *
 * Reattach to a doc-chat turn that is still being written — after a refresh, a
 * slept laptop, or a dropped connection. The client finds a `status='pending'`
 * assistant row when it loads the conversation and picks the stream back up
 * here, sending `offset` so the server replays only what it missed.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string; mid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  const { id: workspaceId, cid: conversationId, mid } = await ctx.params;

  // Ownership: the message must be an assistant row in a conversation of a
  // workspace this user owns. Joining rules out reading someone else's turn by
  // guessing an id.
  const { rows } = await pool.query<{ status: string }>(
    `SELECT m.status
       FROM workspace_messages m
       JOIN workspace_conversations c ON c.id = m.conversation_id
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE m.id = $1 AND m.conversation_id = $2 AND c.workspace_id = $3
        AND w.user_id = $4 AND m.role = 'assistant'`,
    [mid, conversationId, workspaceId, user.id]
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "Turn not found" }, { status: 404 });
  }

  // A turn already finished needs no stream — the row the client just loaded is
  // the whole answer.
  if (rows[0].status !== "pending") {
    return NextResponse.json({ status: rows[0].status, streaming: false });
  }

  // Pending but abandoned by a dead process: fail it now rather than handing the
  // client a stream that would poll until the reaper's own deadline.
  const reaped = await reapStaleTurns(conversationId).catch(() => 0);
  if (reaped > 0) {
    const { rows: after } = await pool.query<{ status: string }>(
      `SELECT status FROM workspace_messages WHERE id = $1`,
      [mid]
    );
    if (after[0]?.status !== "pending") {
      return NextResponse.json({ status: after[0]?.status ?? "error", streaming: false });
    }
  }

  const rawOffset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  return new Response(attachToTurn(mid, offset), { headers: SSE_HEADERS });
}
