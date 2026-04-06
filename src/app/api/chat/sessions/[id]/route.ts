import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import { getSignedPdfUrl } from "@/lib/r2";
import type { CitedCase } from "@/types";

// GET /api/chat/sessions/[id] — Get session with all messages
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await getOrCreateUser({
      uid: decoded.uid,
      email: decoded.email,
    });

    const { id } = await params;

    // Get session (verify ownership)
    const { rows: sessionRows } = await pool.query(
      `SELECT id, title, filters, created_at, updated_at
       FROM chat_sessions
       WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );

    if (sessionRows.length === 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Get messages
    const { rows: messageRows } = await pool.query(
      `SELECT id, session_id, role, content, cited_cases, search_query,
              search_results, context_sent, model, token_usage,
              response_time_ms, error, status, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    // Regenerate signed PDF URLs for SC cases (presigned URLs expire after 1 hour)
    const messagesWithFreshUrls = await Promise.all(
      messageRows.map(async (msg) => {
        if (msg.role !== "assistant" || !msg.cited_cases?.length) return msg;

        const refreshedCases: CitedCase[] = await Promise.all(
          (msg.cited_cases as CitedCase[]).map(async (c) => {
            if (c.source_table === "supreme_court_cases" && c.pdf_path) {
              // Legacy stored paths may be missing the `_EN` suffix that matches
              // the actual R2 object keys. Normalize before signing.
              const normalizedPath = c.pdf_path.endsWith("_EN.pdf")
                ? c.pdf_path
                : c.pdf_path.replace(/\.pdf$/, "_EN.pdf");
              return {
                ...c,
                pdf_path: normalizedPath,
                pdf_url: await getSignedPdfUrl(normalizedPath),
              };
            }
            return c;
          })
        );

        return { ...msg, cited_cases: refreshedCases };
      })
    );

    return NextResponse.json({
      session: sessionRows[0],
      messages: messagesWithFreshUrls,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/chat/sessions/[id]",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/chat/sessions/[id] — Delete a chat session and its messages
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await getOrCreateUser({
      uid: decoded.uid,
      email: decoded.email,
    });

    const { id } = await params;

    // Verify ownership
    const { rows } = await pool.query(
      `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [id, user.id]
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Delete messages first (foreign key), then session
    await pool.query(`DELETE FROM chat_messages WHERE session_id = $1`, [id]);
    await pool.query(`DELETE FROM chat_sessions WHERE id = $1`, [id]);

    return NextResponse.json({ status: "deleted" });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/chat/sessions/[id]",
      method: "DELETE",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
