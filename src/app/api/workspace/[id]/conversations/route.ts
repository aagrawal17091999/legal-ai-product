import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

async function ownWorkspace(userId: number, workspaceId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM workspaces WHERE id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
  return rows.length > 0;
}

// GET /api/workspace/[id]/conversations — list chats in a workspace
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId } = await ctx.params;
    if (!(await ownWorkspace(user.id, workspaceId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              COUNT(m.id)::int AS message_count
         FROM workspace_conversations c
         LEFT JOIN workspace_messages m ON m.conversation_id = c.id
        WHERE c.workspace_id = $1
        GROUP BY c.id
        ORDER BY c.updated_at DESC`,
      [workspaceId]
    );
    return NextResponse.json({ conversations: rows });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/conversations",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/workspace/[id]/conversations — create a new chat
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId } = await ctx.params;
    if (!(await ownWorkspace(user.id, workspaceId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;

    const { rows } = await pool.query(
      `INSERT INTO workspace_conversations (workspace_id, title)
       VALUES ($1, $2)
       RETURNING id, title, created_at, updated_at`,
      [workspaceId, title]
    );
    await pool.query(`UPDATE workspaces SET updated_at = NOW() WHERE id = $1`, [workspaceId]);
    return NextResponse.json({ ...rows[0], message_count: 0 });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/conversations",
      method: "POST",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
