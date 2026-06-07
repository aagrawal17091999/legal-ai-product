import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
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
    const user = await getRequestUser({
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

    // Point Supreme Court PDF links at the download endpoint instead of signing
    // a presigned URL here. Signing eagerly for every cited case on every load
    // is wasted work — most are never opened — and the 1-hour-TTL URLs go stale
    // while a chat stays open. The endpoint signs a fresh URL on click and
    // authenticates via the session cookie.
    const messagesWithPdfLinks = messageRows.map((msg) => {
      if (msg.role !== "assistant" || !msg.cited_cases?.length) return msg;

      const cases: CitedCase[] = (msg.cited_cases as CitedCase[]).map((c) => {
        if (c.source_table === "supreme_court_cases" && c.id != null) {
          return {
            ...c,
            pdf_url: `/api/judgments/download?source=supreme_court_cases&id=${c.id}&redirect=1`,
          };
        }
        return c;
      });

      return { ...msg, cited_cases: cases };
    });

    return NextResponse.json({
      session: sessionRows[0],
      messages: messagesWithPdfLinks,
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
    const user = await getRequestUser({
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
