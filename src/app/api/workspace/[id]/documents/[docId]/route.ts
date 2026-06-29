import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { deleteFromR2 } from "@/lib/r2";
import { logError } from "@/lib/error-logger";

/**
 * DELETE /api/workspace/[id]/documents/[docId]
 *
 * Remove a single document from a workspace. The chunks cascade away via the
 * document_chunks → workspace_documents FK (ON DELETE CASCADE, migration 018),
 * so deleting the row clears its retrieval footprint too. Ownership is enforced
 * with the same documents → workspaces JOIN the sibling routes use, so a user
 * can only delete their own documents. The stored R2 object is removed best-
 * effort after the row is gone (the DB row is the source of truth).
 */
export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; docId: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId, docId } = await ctx.params;

    // Delete only if the document belongs to a workspace the user owns; the
    // RETURNING gives us the r2_key for cleanup (and a 0-row result = not found).
    const { rows } = await pool.query(
      `DELETE FROM workspace_documents d
        USING workspaces w
        WHERE d.workspace_id = w.id
          AND d.id = $1 AND d.workspace_id = $2 AND w.user_id = $3
      RETURNING d.r2_key`,
      [docId, workspaceId, user.id]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await deleteFromR2([rows[0].r2_key]);
    await pool.query(`UPDATE workspaces SET updated_at = NOW() WHERE id = $1`, [workspaceId]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/documents/[docId]",
      method: "DELETE",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
