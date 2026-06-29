import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { requireCredits, OutOfCreditsError } from "@/lib/billing/credits";
import { withMeter, markMeterUnbillable } from "@/lib/billing/meter";
import pool from "@/lib/db";
import { hydrateSessionStore } from "@/lib/rag/sessionStore";
import { runAgent, buildAgentAuditSteps, AgentAbortedError } from "@/lib/rag/agent";
import { persistPipelineAudit } from "@/lib/rag/trace";
import { generateChatTitle } from "@/lib/claude";
import { validateCitations, type CitationMismatch } from "@/lib/rag/citationValidator";
import { normalizeCitations } from "@/lib/rag/citationNormalizer";
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

  const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });

  // Gate on the credit wallet: allow the question through while any balance
  // remains (it may overshoot one action); block once exhausted.
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

  // Serialize turns within a single session. Two messages fired concurrently
  // (double-click, two tabs) would otherwise both read the same history, both
  // insert a user row, and interleave — corrupting message order and possibly
  // double-titling/double-charging. A session-scoped advisory lock (held on a
  // dedicated connection for the life of the turn) makes the second caller wait
  // its turn instead. The lock auto-releases if the function is killed.
  const lockClient = await pool.connect();
  let lockHeld = false;
  try {
    const { rows: lockRows } = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [`chat_session:${sessionId}`]
    );
    lockHeld = lockRows[0]?.locked === true;
  } catch {
    /* lock probe failed — fall through and release below */
  }
  if (!lockHeld) {
    lockClient.release();
    return NextResponse.json(
      { error: "A message is already being processed in this conversation. Please wait." },
      { status: 409 }
    );
  }
  // From here on, lockClient must be released (which drops the advisory lock) on
  // every exit path — done in the stream's finalization below.

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

      // Guarantee the session advisory lock is released on every exit path.
      try {
      const tStart = Date.now();
      const agentStartedAt = new Date(tStart).toISOString();
      let assistantContent = "";
      let status: "success" | "error" | "degraded" = "success";
      let errorMsg: string | null = null;
      let model: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let citedCasesForDb: CitedCase[] = [];
      let citationMismatches: CitationMismatch[] = [];
      let citationUpgrades = 0;
      let faithfulness: {
        ran: boolean;
        checked: number;
        unsupported: number;
        uncertain: number;
      } | null = null;
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

        // Meter the whole agent turn: withMeter establishes the request-scoped
        // usage context here (inside the stream producer), so every Claude +
        // Voyage call nested in runAgent is captured, then debited once the turn
        // completes. The streamed Sonnet steps report usage via addClaudeUsage.
        ({ result: agentResult } = await withMeter(
          { userId: user.id, feature: "chat" },
          async () => {
            const r = await runAgent({
              userMessage,
              history: conversationHistory,
              sessionStore: sessionStoreForTurn!,
              sessionFilters,
              abortSignal: request.signal,
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
              onStatus: (s) => send("status", s),
            });
            // Don't bill a turn that produced no usable answer (the degraded
            // "did not produce a response" path) — the user got nothing.
            if (!r.assistantContent || !r.assistantContent.trim()) {
              markMeterUnbillable();
            }
            return r;
          }
        ));

        assistantContent = agentResult.assistantContent;
        citedCasesForDb = agentResult.citedCases;
        // The streamed "cases" events during retrieval carried no verified
        // support spans (grounding runs only after the draft is written). Re-send
        // the final, support-enriched payload so the live citation panel can show
        // the source passages without waiting for a reload.
        send("cases", citedCasesForDb);
        model = agentResult.model;
        inputTokens = agentResult.tokens.input;
        outputTokens = agentResult.tokens.output;

        // Post-generation citation validation. If the agent ended without any
        // visible text (rare — happens when all steps were tool_use and no
        // end_turn text block was produced), skip validation.
        if (assistantContent) {
          // Normalize bare `[n]` / `[n, ¶p]` markers to the canonical caret form
          // FIRST. The renderer, the citation validator, and the faithfulness
          // judge all match `\[\^…\]`; a bare marker is invisible to all three,
          // so this is what makes those checks (and clickable citations) work.
          const normalized = normalizeCitations(
            assistantContent,
            agentResult.assembledCases.length
          );
          assistantContent = normalized.text;
          citationUpgrades = normalized.upgraded;

          const validation = validateCitations(assistantContent, agentResult.assembledCases);
          if (validation.mismatches.length > 0) {
            const appended = validation.text.slice(assistantContent.length);
            if (appended) send("token", { delta: appended });
            assistantContent = validation.text;
            citationMismatches = validation.mismatches;
          }

          // Groundedness was already checked (and, if needed, revised + footed)
          // INSIDE the agent loop's draft→verify→stream gate — no second judge
          // call here. We just surface its outcome for the audit log.
          faithfulness = agentResult.faithfulness
            ? {
                ran: agentResult.faithfulness.ran,
                checked: agentResult.faithfulness.checked,
                unsupported: agentResult.faithfulness.unsupported,
                uncertain: agentResult.faithfulness.uncertain,
              }
            : null;
        } else {
          // The agent returned no usable text even after the forced-synthesis
          // pass in runAgent. Mark the turn "degraded" (not "success") so these
          // residual misses surface in analytics instead of being counted as
          // healthy answers.
          status = "degraded";
          assistantContent =
            "Sorry, the assistant did not produce a response. Please rephrase your question.";
          send("token", { delta: assistantContent });
          logError({
            category: "chat",
            message: "agent produced empty response after forced synthesis",
            severity: "warning",
            userId: user.id,
            endpoint: "/api/chat/sessions/[id]/messages",
            method: "POST",
            metadata: {
              sessionId,
              steps_used: agentResult?.stepsUsed ?? 0,
              stop_reason: agentResult?.stopReason ?? null,
              cases_loaded: citedCasesForDb.length,
            },
          });
        }
      } catch (err) {
        // A client-cancelled turn (Stop / disconnect) is not an error: the meter
        // was already marked unbillable inside withMeter when runAgent threw, so
        // the user isn't charged. Persist it quietly without a scary log/banner.
        if (err instanceof AgentAbortedError || request.signal.aborted) {
          status = "error";
          errorMsg = "cancelled";
          assistantContent = assistantContent || "(cancelled)";
        } else {
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
        tokens: {
          input: inputTokens,
          output: outputTokens,
          cache_read: agentResult?.tokens.cacheRead ?? 0,
          cache_write: agentResult?.tokens.cacheWrite ?? 0,
        },
        response_time_ms: responseTimeMs,
        warnings: {
          citationMismatches: citationMismatches.length,
          citationUpgrades,
          faithfulness,
          revised: agentResult?.faithfulness?.revised ?? false,
        },
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
            // rag_pipeline_steps uses the "fallback" vocabulary for a
            // degraded-but-completed turn (see migration 011).
            status: status === "degraded" ? "fallback" : status,
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
        // Credits are debited by withMeter() when the agent turn finalizes —
        // no per-question counter to bump here anymore.
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
        // Authoritative final text. Inline markers were normalized to the caret
        // form AFTER streaming, so the client must replace its token-accumulated
        // content with this for citations to render as clickable links.
        content: assistantContent,
      });
      if (!streamClosed) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
      } finally {
        // Drop the session advisory lock (releasing the connection ends it) so
        // the next queued message in this session can proceed.
        try {
          lockClient.release();
        } catch {
          /* already released */
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
