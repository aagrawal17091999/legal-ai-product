import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { requestStop } from "@/lib/docchat/turnRunner";

/**
 * POST /api/workspace/[id]/conversations/[cid]/turns/[mid]/stop
 *
 * Stop is an explicit action rather than "the client closed the socket" — that
 * conflation is what made a refresh cancel an answer. Works from any tab, and
 * across processes via the row's `cancel_requested` flag.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string; mid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
  const { id: workspaceId, cid: conversationId, mid } = await ctx.params;

  const { rows } = await pool.query<{ id: string }>(
    `SELECT m.id
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

  await requestStop(mid);
  return NextResponse.json({ stopped: true });
}
