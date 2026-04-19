import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser, checkQueryLimit, incrementQueryCount } from "@/lib/auth";
import pool from "@/lib/db";
import { hydrateSessionStore } from "@/lib/rag/sessionStore";
import { runAgent, buildAgentAuditSteps } from "@/lib/rag/agent";
import { persistPipelineAudit } from "@/lib/rag/trace";
import { generateChatTitle } from "@/lib/claude";
import { validateCitations, type CitationMismatch } from "@/lib/rag/citationValidator";
import { logError } from "@/lib/error-logger";
import type { ChatMessage, SearchFilters, CitedCase } from "@/types";

/**
 * POST /api/chat/sessions/[id]/messages
 *
 * Streams an SSE response with these event types:
 *   - "meta"   : { mode, model, session_cases_count, session_store, history_turns }
 *   - "tool"   : { phase, tool, input, step_index, status?, duration_ms?, error?, data? }
 *                — phase ∈ "start" | "end"
 *   - "cases"  : CitedCase[] — re-emitted whenever the registry grows
 *   - "token"  : { delta: string } — incremental text from the model
 *   - "title"  : { title: string } — session title (first message only)
 *   - "done"   : { message_id, status, response_time_ms, steps_used, stop_reason }
 *   - "error"  : { message: string }
 *
 * Non-stream errors (auth, limits, validation, session ownership) are returned
 * as normal JSON responses with proper HTTP status codes.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await getOrCreateUser({ uid: decoded.uid, email: decoded.email });

  const { allowed, remaining } = await checkQueryLimit(user.id);
  if (!allowed) {
    return NextResponse.json(
      { error: "limit_reached", remaining },
      { status: 403 }
    );
  }

  const { id: sessionId } = await params;
  const body = await request.json();
  const userMessage: string = body.message;

  if (!userMessage?.trim()) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const { rows: sessionRows } = await pool.query(
    `SELECT id, filters FROM chat_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, user.id]
  );
  if (sessionRows.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const sessionFilters: SearchFilters = sessionRows[0].filters || {};

  const { rows: historyRows } = await pool.query(
    `SELECT id, role, content, cited_cases, search_query, created_at
       FROM chat_messages
      WHERE session_id = $1
      ORDER BY created_at ASC`,
    [sessionId]
  );
  const conversationHistory: ChatMessage[] = historyRows.map((r) => ({
    id: r.id,
    session_id: sessionId,
    role: r.role,
    content: r.content,
    cited_cases: r.cited_cases || [],
    search_query: r.search_query || null,
    search_results: null,
    context_sent: null,
    model: null,
    token_usage: null,
    response_time_ms: null,
    error: null,
    status: "success",
    created_at: r.created_at,
  }));

  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content)
     VALUES ($1, 'user', $2)`,
    [sessionId, userMessage]
  );

  const isFirstUserMessage =
    conversationHistory.filter((m) => m.role === "user").length === 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;
      const send = (event: string, data: unknown) => {
        if (streamClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          streamClosed = true;
        }
      };
      request.signal.addEventListener("abort", () => {
        streamClosed = true;
      });

      const tStart = Date.now();
      const agentStartedAt = new Date(tStart).toISOString();
      let assistantContent = "";
      let status: "success" | "error" = "success";
      let errorMsg: string | null = null;
      let model: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let citedCasesForDb: CitedCase[] = [];
      let citationMismatches: CitationMismatch[] = [];
      let agentResult: Awaited<ReturnType<typeof runAgent>> | null = null;
      let sessionStoreForTurn: Awaited<ReturnType<typeof hydrateSessionStore>> | null = null;

      try {
        sessionStoreForTurn = await hydrateSessionStore(sessionId);

        send("meta", {
          mode: "agent",
          session_cases_count: sessionStoreForTurn.caseSummaries.length,
          session_store: sessionStoreForTurn.trace,
          history_turns: Math.min(conversationHistory.length, 10),
        });

        agentResult = await runAgent({
          userMessage,
          history: conversationHistory,
          sessionStore: sessionStoreForTurn,
          sessionFilters,
          onTextDelta: (delta) => send("token", { delta }),
          onToolEvent: (event) => {
            send("tool", {
              phase: event.type,
              step_index: event.step_index,
              tool: event.record.tool,
              input: event.record.input,
              status: event.type === "end" ? event.record.status : undefined,
              duration_ms: event.type === "end" ? event.record.duration_ms : undefined,
              error: event.type === "end" ? event.record.error : undefined,
              data: event.type === "end" ? event.record.data : undefined,
            });
          },
          onCasesUpdate: (cases) => {
            citedCasesForDb = cases;
            send("cases", cases);
          },
        });

        assistantContent = agentResult.assistantContent;
        citedCasesForDb = agentResult.citedCases;
        model = agentResult.model;
        inputTokens = agentResult.tokens.input;
        outputTokens = agentResult.tokens.output;

        // Post-generation citation validation. If the agent ended without any
        // visible text (rare — happens when all steps were tool_use and no
        // end_turn text block was produced), skip validation.
        if (assistantContent) {
          const validation = validateCitations(assistantContent, agentResult.assembledCases);
          if (validation.mismatches.length > 0) {
            const appended = validation.text.slice(assistantContent.length);
            if (appended) send("token", { delta: appended });
            assistantContent = validation.text;
            citationMismatches = validation.mismatches;
          }
        } else {
          assistantContent =
            "Sorry, the assistant did not produce a response. Please rephrase your question.";
          send("token", { delta: assistantContent });
        }
      } catch (err) {
        status = "error";
        errorMsg = err instanceof Error ? err.message : String(err);
        assistantContent =
          assistantContent ||
          "Sorry, I encountered an error generating a response. Please try again.";
        logError({
          category: "chat",
          message: `Agent stream failed: ${errorMsg}`,
          error: err,
          userId: user.id,
          endpoint: "/api/chat/sessions/[id]/messages",
          method: "POST",
          metadata: { sessionId },
        });
        send("error", { message: errorMsg });
      }

      const responseTimeMs = Date.now() - tStart;

      // Compose rag_trace with agent-shape metadata.
      const ragTrace: Record<string, unknown> = {
        mode: "agent",
        model,
        steps_used: agentResult?.stepsUsed ?? 0,
        stop_reason: agentResult?.stopReason ?? null,
        tool_calls: (agentResult?.toolTrace ?? []).map((t) => ({
          tool: t.tool,
          input: t.input,
          status: t.status,
          duration_ms: t.duration_ms,
          error: t.error,
          data: t.data,
        })),
        session_store: sessionStoreForTurn?.trace ?? null,
        case_count: citedCasesForDb.length,
        tokens: { input: inputTokens, output: outputTokens },
        response_time_ms: responseTimeMs,
        warnings: { citationMismatches: citationMismatches.length },
      };

      let assistantRowId: string | null = null;
      try {
        const { rows: assistantRows } = await pool.query(
          `INSERT INTO chat_messages
             (session_id, role, content, cited_cases, search_query, search_results,
              context_sent, model, token_usage, response_time_ms, error, status, rag_trace)
           VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            sessionId,
            assistantContent,
            JSON.stringify(citedCasesForDb),
            userMessage,
            agentResult
              ? JSON.stringify(agentResult.toolTrace.map((t) => ({
                  tool: t.tool,
                  duration_ms: t.duration_ms,
                  data: t.data,
                })))
              : null,
            agentResult?.contextDebug ?? null,
            model,
            inputTokens !== null && outputTokens !== null
              ? JSON.stringify({ input_tokens: inputTokens, output_tokens: outputTokens })
              : null,
            responseTimeMs,
            errorMsg,
            status,
            JSON.stringify(ragTrace),
          ]
        );
        assistantRowId = assistantRows[0]?.id ?? null;
      } catch (err) {
        logError({
          category: "database",
          message: `failed to persist assistant message: ${err instanceof Error ? err.message : String(err)}`,
          error: err,
          severity: "critical",
          userId: user.id,
          endpoint: "/api/chat/sessions/[id]/messages",
          method: "POST",
          metadata: { sessionId },
        });
      }

      if (assistantRowId && sessionStoreForTurn) {
        const steps = buildAgentAuditSteps({
          userMessage,
          sessionStore: sessionStoreForTurn,
          toolTrace: agentResult?.toolTrace ?? [],
          generate: {
            status,
            duration_ms: responseTimeMs,
            started_at: agentStartedAt,
            error: errorMsg,
            data: {
              model,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              content_chars: assistantContent.length,
              stop_reason: agentResult?.stopReason ?? null,
              citation_mismatches: citationMismatches,
            },
          },
          agentStartedAt,
        });
        await persistPipelineAudit(assistantRowId, steps, []);
      }

      try {
        if (isFirstUserMessage) {
          const title = await generateChatTitle(userMessage);
          await pool.query(
            `UPDATE chat_sessions SET title = $1, updated_at = NOW() WHERE id = $2`,
            [title, sessionId]
          );
          send("title", { title });
        } else {
          await pool.query(
            `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`,
            [sessionId]
          );
        }
        await incrementQueryCount(user.id);
      } catch (err) {
        logError({
          category: "database",
          message: `post-stream bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
          error: err,
          severity: "warning",
          userId: user.id,
          endpoint: "/api/chat/sessions/[id]/messages",
          metadata: { sessionId },
        });
      }

      send("done", {
        message_id: assistantRowId,
        status,
        response_time_ms: responseTimeMs,
        steps_used: agentResult?.stepsUsed ?? 0,
        stop_reason: agentResult?.stopReason ?? null,
      });
      if (!streamClosed) {
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
