import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { deleteFromR2 } from "@/lib/r2";
import { expireStaleDocuments } from "@/lib/docchat/expire";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";

async function ownWorkspace(userId: number, workspaceId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM workspaces WHERE id = $1 AND user_id = $2`,
    [workspaceId, userId]
  );
  return rows.length > 0;
}

// GET /api/workspace/[id] — workspace detail: documents + message history
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id } = await ctx.params;
    if (!(await ownWorkspace(user.id, id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Settle any document whose ingestion died with the process, so this read
    // returns a terminal `failed` state instead of a permanent "Processing".
    await expireStaleDocuments(id);

    const [ws, docs, convs] = await Promise.all([
      pool.query(`SELECT id, title, created_at, updated_at FROM workspaces WHERE id = $1`, [id]),
      pool.query(
        `SELECT id, filename, mime, status, page_count, ocr_used, char_count, chunk_count, error, created_at
           FROM workspace_documents WHERE workspace_id = $1 ORDER BY created_at ASC`,
        [id]
      ),
      pool.query(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
                COUNT(m.id)::int AS message_count
           FROM workspace_conversations c
           LEFT JOIN workspace_messages m ON m.conversation_id = c.id
          WHERE c.workspace_id = $1
          GROUP BY c.id
          ORDER BY c.updated_at DESC`,
        [id]
      ),
    ]);

    return NextResponse.json({
      workspace: ws.rows[0],
      documents: docs.rows,
      conversations: convs.rows,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/workspace/[id] — rename a workspace
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const raw = typeof body.title === "string" ? body.title.trim() : "";
    // Empty title clears back to "Untitled"; otherwise cap the length.
    const title = raw ? raw.slice(0, 200) : null;

    const { rows } = await pool.query(
      `UPDATE workspaces SET title = $1, updated_at = NOW()
        WHERE id = $2 AND user_id = $3
        RETURNING id, title, created_at, updated_at`,
      [title, id, user.id]
    );
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    track(EVENTS.WORKSPACE_RENAMED, {
      userId: user.id,
      properties: { workspace_id: id, title },
    });
    return NextResponse.json(rows[0]);
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]",
      method: "PATCH",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/workspace/[id] — delete a workspace (cascades to docs/chunks/messages)
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id } = await ctx.params;

    // Collect the stored files before the row (and its docs) cascade away, so we
    // can clean them out of R2 afterward.
    const { rows: docRows } = await pool.query(
      `SELECT d.r2_key
         FROM workspace_documents d
         JOIN workspaces w ON w.id = d.workspace_id
        WHERE d.workspace_id = $1 AND w.user_id = $2`,
      [id, user.id]
    );

    const { rows: deleted } = await pool.query<{ title: string | null; created_at: Date }>(
      `DELETE FROM workspaces WHERE id = $1 AND user_id = $2 RETURNING title, created_at`,
      [id, user.id]
    );
    if (deleted.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await deleteFromR2(docRows.map((r) => r.r2_key));
    track(EVENTS.WORKSPACE_DELETED, {
      userId: user.id,
      properties: {
        workspace_id: id,
        title: deleted[0].title,
        documents_deleted: docRows.length,
        workspace_created_at: deleted[0].created_at,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]",
      method: "DELETE",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
