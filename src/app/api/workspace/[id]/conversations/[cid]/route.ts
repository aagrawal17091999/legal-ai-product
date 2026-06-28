import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

async function ownConversation(
  userId: number,
  workspaceId: string,
  conversationId: string
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1
       FROM workspace_conversations c
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = $1 AND c.workspace_id = $2 AND w.user_id = $3`,
    [conversationId, workspaceId, userId]
  );
  return rows.length > 0;
}

// PATCH /api/workspace/[id]/conversations/[cid] — rename a chat
export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId, cid } = await ctx.params;
    if (!(await ownConversation(user.id, workspaceId, cid))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const raw = typeof body.title === "string" ? body.title.trim() : "";
    const title = raw ? raw.slice(0, 200) : null;

    const { rows } = await pool.query(
      `UPDATE workspace_conversations SET title = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, title, created_at, updated_at`,
      [title, cid]
    );
    return NextResponse.json(rows[0]);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/conversations/[cid]",
      method: "PATCH",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/workspace/[id]/conversations/[cid] — delete a chat (cascades to messages)
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId, cid } = await ctx.params;
    if (!(await ownConversation(user.id, workspaceId, cid))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await pool.query(`DELETE FROM workspace_conversations WHERE id = $1`, [cid]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/conversations/[cid]",
      method: "DELETE",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
