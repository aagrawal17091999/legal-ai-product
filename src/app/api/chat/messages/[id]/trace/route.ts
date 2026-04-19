import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

/**
 * GET /api/chat/messages/[id]/trace
 *
 * Returns the per-turn debug payload for a chat message:
 *   - the chat_messages row itself (content, cited_cases, rag_trace, usage)
 *   - every rag_pipeline_steps row linked to the message, ordered by step_order
 *
 * Scope: staff-only. Non-staff (including the message's own author) get 404,
 * not 403 — we don't leak whether the debug surface exists. Every successful
 * read is recorded in trace_access_log for audit.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await getOrCreateUser({ uid: decoded.uid, email: decoded.email });
    const { id: messageId } = await params;

    // Staff-only. Non-staff users get 404 so the URL stays opaque and the
    // existence of the debug surface isn't advertised to the general user
    // base. Staff can read any user's trace (that's the whole point — debug
    // reports from real users).
    if (!user.is_staff) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { rows: messageRows } = await pool.query(
      `SELECT cm.id, cm.session_id, cm.role, cm.content, cm.cited_cases,
              cm.search_query, cm.model, cm.token_usage, cm.response_time_ms,
              cm.rag_trace, cm.status, cm.error, cm.created_at,
              cs.title AS session_title
         FROM chat_messages cm
         JOIN chat_sessions cs ON cs.id = cm.session_id
        WHERE cm.id = $1`,
      [messageId]
    );
    if (messageRows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const message = messageRows[0];

    // Audit: record every staff read. Best-effort; a failure here must not
    // block the response. The row survives chat_messages deletion — the
    // table stores message_id as a plain UUID, not a FK.
    pool
      .query(
        `INSERT INTO trace_access_log (user_id, message_id) VALUES ($1, $2)`,
        [user.id, messageId]
      )
      .catch((err) => {
        logError({
          category: "database",
          message: `trace_access_log insert failed: ${err instanceof Error ? err.message : String(err)}`,
          error: err,
          severity: "warning",
          userId: user.id,
          endpoint: "/api/chat/messages/[id]/trace",
        });
      });

    const { rows: stepRows } = await pool.query(
      `SELECT step_order, step, status, duration_ms, error, data, created_at
         FROM rag_pipeline_steps
        WHERE message_id = $1
        ORDER BY step_order ASC`,
      [messageId]
    );

    // Also fetch the user message that triggered this assistant turn (the
    // immediately-preceding user row in the same session) so the debug page
    // can show "the question" alongside the trace.
    let triggeringMessage: { id: string; content: string; created_at: string } | null = null;
    if (message.role === "assistant") {
      const { rows: triggerRows } = await pool.query(
        `SELECT id, content, created_at
           FROM chat_messages
          WHERE session_id = $1
            AND role = 'user'
            AND created_at < $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [message.session_id, message.created_at]
      );
      triggeringMessage = triggerRows[0] ?? null;
    }

    return NextResponse.json({
      message: {
        id: message.id,
        session_id: message.session_id,
        session_title: message.session_title,
        role: message.role,
        content: message.content,
        cited_cases: message.cited_cases ?? [],
        search_query: message.search_query,
        model: message.model,
        token_usage: message.token_usage,
        response_time_ms: message.response_time_ms,
        rag_trace: message.rag_trace,
        status: message.status,
        error: message.error,
        created_at: message.created_at,
      },
      triggering_message: triggeringMessage,
      pipeline_steps: stepRows,
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/chat/messages/[id]/trace",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
