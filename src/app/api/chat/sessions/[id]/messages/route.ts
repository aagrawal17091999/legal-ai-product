import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser, checkQueryLimit, incrementQueryCount } from "@/lib/auth";
import pool from "@/lib/db";
import {
  runRagPipeline,
  type RagResult,
  type PipelineStepRecord,
} from "@/lib/rag/pipeline";
import { persistPipelineAudit } from "@/lib/rag/trace";
import { streamChatResponse, generateChatTitle } from "@/lib/claude";
import { logError } from "@/lib/error-logger";
import type { ChatMessage, SearchFilters } from "@/types";

/**
 * POST /api/chat/sessions/[id]/messages
 *
 * Streams an SSE response with these event types:
 *   - "meta"  : { rewritten_queries, effective_filters, needs_retrieval }
 *   - "cases" : CitedCase[] — sent as soon as retrieval + context assembly finish
 *   - "token" : { delta: string } — incremental text from Claude
 *   - "title" : { title: string } — session title (first message only)
 *   - "done"  : { message_id, status, response_time_ms }
 *   - "error" : { message: string }
 *
 * Non-stream errors (auth, limits, validation, session ownership) are still
 * returned as normal JSON responses with proper HTTP status codes.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await getOrCreateUser({
    uid: decoded.uid,
    email: decoded.email,
  });

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
    return NextResponse.json(
      { error: "Message is required" },
      { status: 400 }
    );
  }

  // Verify session ownership BEFORE opening the stream so we can return 404.
  const { rows: sessionRows } = await pool.query(
    `SELECT id, filters FROM chat_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, user.id]
  );
  if (sessionRows.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const sessionFilters: SearchFilters = sessionRows[0].filters || {};

  // Load history BEFORE opening the stream — we need it for query understanding.
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

  // Save the user message now (outside the stream) so it's persisted even if
  // the client disconnects mid-stream.
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
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      const tStart = Date.now();
      let assistantContent = "";
      let status: "success" | "error" = "success";
      let errorMsg: string | null = null;
      let model: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let contextSent: string | null = null;
      let citedCasesForDb: unknown[] = [];
      let ragTrace: Record<string, unknown> | null = null;
      let rag: RagResult | null = null;
      let generateStep: PipelineStepRecord | null = null;

      try {
        // 1. Run RAG pipeline.
        rag = await runRagPipeline(userMessage, conversationHistory, sessionFilters);

        send("meta", {
          needs_retrieval: rag.needsRetrieval,
          rewritten_queries: rag.understanding.rewritten_queries,
          implicit_filters: rag.understanding.implicit_filters,
          effective_filters: rag.effectiveFilters,
          timings: rag.timings,
        });
        send("cases", rag.citedCases);

        citedCasesForDb = rag.citedCases;
        ragTrace = {
          needs_retrieval: rag.needsRetrieval,
          rewritten_queries: rag.understanding.rewritten_queries,
          hyde_passage: rag.understanding.hyde_passage,
          implicit_filters: rag.understanding.implicit_filters,
          effective_filters: rag.effectiveFilters,
          candidate_chunk_ids: rag.candidateChunks.map((c) => c.chunk_id),
          reranked_chunks: rag.rerankedChunks.map((c) => ({
            chunk_id: c.chunk_id,
            source_table: c.source_table,
            source_id: c.source_id,
            chunk_index: c.chunk_index,
            rrf_score: c.rrf_score,
          })),
          case_count: rag.cases.length,
          timings: rag.timings,
        };

        // 2. Kick off Claude streaming. For chitchat (no retrieval), context is empty.
        const tGenerateStart = Date.now();
        const { stream: claudeStream, contextSent: cs, model: usedModel } = streamChatResponse(
          conversationHistory,
          rag.contextString,
          userMessage
        );
        contextSent = cs;
        model = usedModel;

        let firstTokenMs: number | null = null;
        claudeStream.on("text", (delta: string) => {
          if (firstTokenMs === null) firstTokenMs = Date.now() - tGenerateStart;
          assistantContent += delta;
          send("token", { delta });
        });

        const finalMsg = await claudeStream.finalMessage();
        const tGenerateEnd = Date.now();
        inputTokens = finalMsg.usage.input_tokens;
        outputTokens = finalMsg.usage.output_tokens;
        model = finalMsg.model;

        // If the SDK produced any text that wasn't forwarded via the text
        // event (shouldn't happen in practice), fall back to the final content.
        if (!assistantContent) {
          const textBlock = finalMsg.content.find((b) => b.type === "text");
          if (textBlock && "text" in textBlock) {
            assistantContent = textBlock.text;
            send("token", { delta: assistantContent });
          }
        }

        generateStep = {
          step_order: 6,
          step: "generate",
          status: "success",
          duration_ms: tGenerateEnd - tGenerateStart,
          started_at: new Date(tGenerateStart).toISOString(),
          error: null,
          data: {
            model: finalMsg.model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            content_chars: assistantContent.length,
            first_token_ms: firstTokenMs,
            stop_reason: finalMsg.stop_reason,
            context_chars: rag.contextString.length,
            history_turns_sent: Math.min(conversationHistory.length, 10),
          },
        };
      } catch (err) {
        status = "error";
        errorMsg = err instanceof Error ? err.message : String(err);
        assistantContent =
          assistantContent ||
          "Sorry, I encountered an error generating a response. Please try again.";
        logError({
          category: "chat",
          message: `Chat stream failed: ${errorMsg}`,
          error: err,
          userId: user.id,
          endpoint: "/api/chat/sessions/[id]/messages",
          method: "POST",
          metadata: { sessionId },
        });
        send("error", { message: errorMsg });

        // Record the generate step as errored so the audit log still has a
        // complete 6-row trace even when Claude failed.
        generateStep = {
          step_order: 6,
          step: "generate",
          status: "error",
          duration_ms: 0,
          started_at: new Date().toISOString(),
          error: errorMsg,
          data: {
            context_chars: rag?.contextString.length ?? 0,
          },
        };
      }

      const responseTimeMs = Date.now() - tStart;

      // 3. Persist the assistant message with full tracing.
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
            // search_results is now the reranked chunk trace rather than
            // the old SearchResult[] shape — lives in rag_trace too but we
            // keep the column populated for the admin UI.
            ragTrace ? JSON.stringify(ragTrace.reranked_chunks) : null,
            contextSent,
            model,
            inputTokens !== null && outputTokens !== null
              ? JSON.stringify({ input_tokens: inputTokens, output_tokens: outputTokens })
              : null,
            responseTimeMs,
            errorMsg,
            status,
            ragTrace ? JSON.stringify(ragTrace) : null,
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

      // 3b. Persist per-step audit rows (rag_pipeline_steps + rag_query_embeddings).
      // Best-effort: failures are logged inside persistPipelineAudit but never
      // surface to the user. Requires assistantRowId for the FK — skipped if
      // the chat_messages insert failed above.
      if (assistantRowId && rag) {
        const allSteps = generateStep ? [...rag.steps, generateStep] : rag.steps;
        await persistPipelineAudit(assistantRowId, allSteps, rag.queryEmbeddings);
      }

      // 4. Title generation + session updated_at + query count. These run
      // after the stream so they don't delay the first token.
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
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so the client sees tokens immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
