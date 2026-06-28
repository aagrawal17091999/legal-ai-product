import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { requireCredits, OutOfCreditsError } from "@/lib/billing/credits";
import { withMeter } from "@/lib/billing/meter";
import pool from "@/lib/db";
import { runDocChat, type DocChatTurn, type DocCitation } from "@/lib/docchat/answer";
import { logError } from "@/lib/error-logger";

export const maxDuration = 120;

// GET /api/workspace/[id]/conversations/[cid]/messages — message history for one chat
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const { id: workspaceId, cid: conversationId } = await ctx.params;

    const { rows: convRows } = await pool.query(
      `SELECT 1
         FROM workspace_conversations c
         JOIN workspaces w ON w.id = c.workspace_id
        WHERE c.id = $1 AND c.workspace_id = $2 AND w.user_id = $3`,
      [conversationId, workspaceId, user.id]
    );
    if (convRows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { rows } = await pool.query(
      `SELECT id, role, content, citations, status, created_at
         FROM workspace_messages
        WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId]
    );
    return NextResponse.json({ messages: rows });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/workspace/[id]/conversations/[cid]/messages
 *
 * Streams an SSE response (same framing as the case-law chat):
 *   - "status"    : { phase: "retrieving" | "verifying" }
 *   - "token"     : { delta }
 *   - "citations" : DocCitation[]
 *   - "done"      : { message_id, status, content }
 *   - "error"     : { message }
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; cid: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });

  try {
    await requireCredits(user.id);
  } catch (e) {
    if (e instanceof OutOfCreditsError) {
      return NextResponse.json(
        { error: "insufficient_credits", remaining: e.remaining },
        { status: 402 }
      );
    }
    throw e;
  }

  const { id: workspaceId, cid: conversationId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const userMessage: string = body.message;
  if (!userMessage?.trim()) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  // The conversation must exist, belong to this workspace, and be owned by the user.
  const { rows: convRows } = await pool.query(
    `SELECT c.id, c.title
       FROM workspace_conversations c
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = $1 AND c.workspace_id = $2 AND w.user_id = $3`,
    [conversationId, workspaceId, user.id]
  );
  if (convRows.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const conversationTitle: string | null = convRows[0].title;

  // Guard: require at least one ready document so we never "answer from nothing".
  const { rows: readyRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM workspace_documents WHERE workspace_id = $1 AND status = 'ready'`,
    [workspaceId]
  );
  if (readyRows[0].n === 0) {
    return NextResponse.json(
      { error: "no_documents", message: "Upload and process at least one document first." },
      { status: 400 }
    );
  }

  const { rows: historyRows } = await pool.query(
    `SELECT role, content FROM workspace_messages
      WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );
  const history: DocChatTurn[] = historyRows.map((r) => ({ role: r.role, content: r.content }));

  await pool.query(
    `INSERT INTO workspace_messages (workspace_id, conversation_id, role, content)
     VALUES ($1, $2, 'user', $3)`,
    [workspaceId, conversationId, userMessage]
  );

  // Auto-title an untitled conversation from its first user message.
  if (!conversationTitle && history.length === 0) {
    await pool.query(
      `UPDATE workspace_conversations SET title = $2 WHERE id = $1 AND title IS NULL`,
      [conversationId, userMessage.trim().slice(0, 80)]
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      request.signal.addEventListener("abort", () => {
        closed = true;
      });

      const tStart = Date.now();
      let assistantContent = "";
      let citations: DocCitation[] = [];
      let status: "success" | "error" = "success";
      let errorMsg: string | null = null;
      let model: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;

      try {
        // Meter the whole doc-chat turn (analyze + retrieve/embed/rerank + the
        // streamed answer + citation verify) and debit when it finalizes.
        const { result } = await withMeter(
          { userId: user.id, feature: "workspace_chat" },
          () =>
            runDocChat({
              workspaceId,
              userMessage,
              history,
              onTextDelta: (delta) => send("token", { delta }),
              onStatus: (s) => send("status", s),
            })
        );
        assistantContent = result.assistantContent;
        citations = result.citations;
        model = result.model;
        inputTokens = result.tokens.input;
        outputTokens = result.tokens.output;
        send("citations", citations);
      } catch (err) {
        status = "error";
        errorMsg = err instanceof Error ? err.message : String(err);
        assistantContent =
          assistantContent || "Sorry, I encountered an error answering from your documents. Please try again.";
        logError({
          category: "chat",
          message: `Doc chat failed: ${errorMsg}`,
          error: err,
          userId: user.id,
          endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
          method: "POST",
          metadata: { workspaceId, conversationId },
        });
        send("error", { message: errorMsg });
      }

      const responseTimeMs = Date.now() - tStart;
      let assistantId: string | null = null;
      try {
        const { rows } = await pool.query(
          `INSERT INTO workspace_messages
             (workspace_id, conversation_id, role, content, citations, model, token_usage, response_time_ms, status, error)
           VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            workspaceId,
            conversationId,
            assistantContent,
            JSON.stringify(citations),
            model,
            inputTokens !== null && outputTokens !== null
              ? JSON.stringify({ input_tokens: inputTokens, output_tokens: outputTokens })
              : null,
            responseTimeMs,
            status,
            errorMsg,
          ]
        );
        assistantId = rows[0]?.id ?? null;
        await pool.query(
          `UPDATE workspace_conversations SET updated_at = NOW() WHERE id = $1`,
          [conversationId]
        );
        await pool.query(`UPDATE workspaces SET updated_at = NOW() WHERE id = $1`, [workspaceId]);
        // Credits debited by withMeter() above — no per-question counter.
      } catch (err) {
        logError({
          category: "database",
          message: `failed to persist workspace message: ${err instanceof Error ? err.message : String(err)}`,
          error: err,
          severity: "critical",
          userId: user.id,
          endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
          metadata: { workspaceId, conversationId },
        });
      }

      send("done", {
        message_id: assistantId,
        status,
        response_time_ms: responseTimeMs,
        content: assistantContent,
      });
      if (!closed) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
