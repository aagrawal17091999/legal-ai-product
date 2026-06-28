import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { getSignedObjectUrl } from "@/lib/r2";
import { logError } from "@/lib/error-logger";

/**
 * GET /api/workspace/[id]/documents/[docId]/file
 *
 * Returns a short-lived presigned R2 URL for the original uploaded file, so the
 * client (which authenticates with a Bearer token and therefore can't use a
 * plain redirect/anchor) can open it in a new tab. Ownership is checked before
 * any URL is minted. PDFs/images render in the browser; DOCX downloads.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; docId: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId, docId } = await ctx.params;

    const { rows } = await pool.query(
      `SELECT d.r2_key
         FROM workspace_documents d
         JOIN workspaces w ON w.id = d.workspace_id
        WHERE d.id = $1 AND d.workspace_id = $2 AND w.user_id = $3`,
      [docId, workspaceId, user.id]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const url = await getSignedObjectUrl(rows[0].r2_key);
    return NextResponse.json({ url });
  } catch (err) {
    logError({
      category: "fetching",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/documents/[docId]/file",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
