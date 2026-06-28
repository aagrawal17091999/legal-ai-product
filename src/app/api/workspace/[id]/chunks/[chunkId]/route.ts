import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import { expandToSentences } from "@/lib/extract/chunk";

/**
 * GET /api/workspace/[id]/chunks/[chunkId]
 *
 * Returns the cited passage for the source panel. Retrieval chunks are fixed
 * character windows that begin/end mid-sentence, so when the document was
 * ingested with character offsets (start_offset/end_offset) and its full_text is
 * available, we expand the chunk's range out to the enclosing sentence
 * boundaries and return that clean `passage`. Documents ingested before offsets
 * existed fall back to the verbatim chunk text plus its immediate neighbours.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; chunkId: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId, chunkId } = await ctx.params;
    const chunkIdNum = parseInt(chunkId, 10);
    if (!Number.isFinite(chunkIdNum)) {
      return NextResponse.json({ error: "Invalid chunk id" }, { status: 400 });
    }

    // Fetch the chunk, scoped to a workspace the user owns.
    const { rows } = await pool.query(
      `SELECT dc.id, dc.document_id, dc.chunk_index, dc.page_no, dc.chunk_text,
              dc.start_offset, dc.end_offset,
              d.filename AS document_name, d.full_text
         FROM document_chunks dc
         JOIN workspace_documents d ON d.id = dc.document_id
         JOIN workspaces w ON w.id = dc.workspace_id
        WHERE dc.id = $1 AND dc.workspace_id = $2 AND w.user_id = $3`,
      [chunkIdNum, workspaceId, user.id]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const chunk = rows[0];

    // Preferred path: the document was ingested with offsets + full_text, so we
    // can grow the cited chunk back out to whole sentences for a clean passage.
    const hasOffsets =
      typeof chunk.full_text === "string" &&
      chunk.full_text.length > 0 &&
      chunk.start_offset != null &&
      chunk.end_offset != null;

    const passage = hasOffsets
      ? expandToSentences(chunk.full_text, chunk.start_offset, chunk.end_offset)
      : null;

    // Legacy fallback (pre-offsets documents): show the verbatim chunk plus its
    // immediate neighbours, exactly as before.
    let context: Array<{
      chunk_index: number;
      page_no: number | null;
      chunk_text: string;
      is_cited: boolean;
    }> = [];
    if (!passage) {
      const { rows: neighbors } = await pool.query(
        `SELECT chunk_index, page_no, chunk_text
           FROM document_chunks
          WHERE document_id = $1 AND chunk_index BETWEEN $2 AND $3
          ORDER BY chunk_index`,
        [chunk.document_id, chunk.chunk_index - 1, chunk.chunk_index + 1]
      );
      context = neighbors.map((n) => ({
        chunk_index: n.chunk_index,
        page_no: n.page_no,
        chunk_text: n.chunk_text,
        is_cited: n.chunk_index === chunk.chunk_index,
      }));
    }

    return NextResponse.json({
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      document_name: chunk.document_name,
      chunk_index: chunk.chunk_index,
      page_no: chunk.page_no,
      chunk_text: chunk.chunk_text,
      // Clean sentence-aligned passage when available; null for legacy docs.
      passage,
      context,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/chunks/[chunkId]",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
