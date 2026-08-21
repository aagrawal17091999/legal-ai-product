/**
 * Case-law chat: the durable-turn adapter.
 *
 * The engine in lib/turns/durableTurns.ts owns streaming, durability and
 * liveness. This file owns what is specific to research turns: writing the
 * user + pending assistant rows, running the agent, normalizing and validating
 * citations, finalizing the row, and the session bookkeeping that follows.
 *
 * The turn deliberately does NOT belong to the request that started it — see
 * the engine's header for why, and what recovers a turn whose process died.
 */
import pool from "@/lib/db";
import type { PoolClient } from "pg";
import { withMeter, markMeterUnbillable } from "@/lib/billing/meter";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import { hydrateSessionStore } from "@/lib/rag/sessionStore";
import { runAgent, buildAgentAuditSteps, AgentAbortedError } from "@/lib/rag/agent";
import { persistPipelineAudit } from "@/lib/rag/trace";
import { generateChatTitle } from "@/lib/claude";
import { validateCitations, type CitationMismatch } from "@/lib/rag/citationValidator";
import { normalizeCitations } from "@/lib/rag/citationNormalizer";
import { logError } from "@/lib/error-logger";
import {
  beginTurn,
  endTurn,
  abandonTurn,
  stopFlushing,
  releaseTurnLock,
  attachToTurn as attachToTurnGeneric,
  reapStaleTurns as reapStaleTurnsGeneric,
  requestStop as requestStopGeneric,
  type LiveTurn,
  type TurnTable,
} from "@/lib/turns/durableTurns";
import type { ChatMessage, SearchFilters, CitedCase, User } from "@/types";

export { streamNewTurn, SSE_HEADERS } from "@/lib/turns/durableTurns";

/** Where research turns live, and what this stream calls its citation payload. */
export const CHAT_TURNS: TurnTable = {
  table: "chat_messages",
  threadColumn: "session_id",
  citationsColumn: "cited_cases",
  citationsEvent: "cases",
  interruptedText:
    "This answer was interrupted before it could be written. Please ask again.",
};

/** Attach to a research turn, resuming from the text the client already has. */
export function attachToTurn(messageId: string, fromOffset: number) {
  return attachToTurnGeneric(CHAT_TURNS, messageId, fromOffset);
}

/** Stop a research turn — an explicit act, not a closed connection. */
export function requestStop(messageId: string): Promise<void> {
  return requestStopGeneric(CHAT_TURNS, messageId);
}

/** Fail research turns whose runner died. */
export function reapStaleTurns(sessionId?: string): Promise<number> {
  return reapStaleTurnsGeneric(CHAT_TURNS, sessionId);
}

export interface StartTurnParams {
  user: User;
  sessionId: string;
  userMessage: string;
  sessionFilters: SearchFilters;
  /**
   * The connection holding this session's advisory lock. Ownership transfers to
   * the runner: the turn now outlives the request, so the request must not
   * release it. The runner releases it on every exit path.
   */
  lockClient: PoolClient;
}

/**
 * Write both rows, register the turn, and kick the agent off detached. Returns
 * as soon as the assistant row exists, so the caller can hand the client a
 * message id to stream from (and to reattach to later).
 */
export async function startTurn(
  params: StartTurnParams
): Promise<{ messageId: string }> {
  const { user, sessionId, userMessage, sessionFilters, lockClient } = params;

  // History for the prompt. `status <> 'pending'` skips any half-written turn
  // an earlier crash left behind — the advisory lock rules out a live one.
  const { rows: historyRows } = await pool.query(
    `SELECT id, role, content, cited_cases, search_query, created_at
       FROM chat_messages
      WHERE session_id = $1 AND status <> 'pending'
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
  const isFirstUserMessage =
    conversationHistory.filter((m) => m.role === "user").length === 0;

  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content)
     VALUES ($1, 'user', $2)`,
    [sessionId, userMessage]
  );

  // The assistant row exists before a single token does. This is what makes the
  // turn discoverable after a reload: the session load sees a 'pending' row and
  // reattaches to it.
  const agentStartedAt = new Date().toISOString();
  const { rows: pendingRows } = await pool.query<{ id: string }>(
    `INSERT INTO chat_messages
       (session_id, role, content, search_query, status, heartbeat_at, live_state)
     VALUES ($1, 'assistant', '', $2, 'pending', NOW(), $3)
     RETURNING id`,
    [sessionId, userMessage, JSON.stringify({ started_at: agentStartedAt })]
  );
  const messageId = pendingRows[0].id;

  // Ownership of the advisory-lock connection transfers to the engine here: the
  // turn outlives the request that took the lock, so the request must not
  // release it.
  const turn = beginTurn({
    table: CHAT_TURNS,
    messageId,
    lock: lockClient,
    context: { sessionId, userId: user.id },
  });

  // Floating on purpose — this is the whole point. `runTurn` never rejects.
  void runTurn({
    turn,
    user,
    sessionId,
    userMessage,
    sessionFilters,
    conversationHistory,
    isFirstUserMessage,
    agentStartedAt,
  });

  return { messageId };
}

// ---------------------------------------------------------------------------
// The detached agent run
// ---------------------------------------------------------------------------

interface RunTurnParams {
  turn: LiveTurn;
  user: User;
  sessionId: string;
  userMessage: string;
  sessionFilters: SearchFilters;
  conversationHistory: ChatMessage[];
  isFirstUserMessage: boolean;
  agentStartedAt: string;
}

async function runTurn(p: RunTurnParams): Promise<void> {
  const {
    turn,
    user,
    sessionId,
    userMessage,
    sessionFilters,
    conversationHistory,
    isFirstUserMessage,
    agentStartedAt,
  } = p;

  const tStart = Date.parse(agentStartedAt);
  let assistantContent = "";
  let status: "success" | "degraded" | "error" = "success";
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
  let turnMeter: Awaited<ReturnType<typeof withMeter>>["meter"] | null = null;
  let sessionStoreForTurn: Awaited<ReturnType<typeof hydrateSessionStore>> | null = null;

  // Streaming, buffering and durability all live in the engine; this adapter
  // just emits.
  const send = (event: string, data: unknown) => turn.send(event, data);



  try {
    try {
      sessionStoreForTurn = await hydrateSessionStore(sessionId);

      send("meta", {
        mode: "agent",
        session_cases_count: sessionStoreForTurn.caseSummaries.length,
        session_store: sessionStoreForTurn.trace,
        history_turns: Math.min(conversationHistory.length, 10),
      });

      track(EVENTS.RESEARCH_ASKED, {
        userId: user.id,
        properties: {
          // Length only — never the question itself (see analytics/events.ts).
          message_length: userMessage.length,
          history_turns: Math.min(conversationHistory.length, 10),
          has_filters: Boolean(sessionFilters),
        },
      });

      // Meter the whole agent turn: withMeter establishes the usage context
      // here, inside the detached task, so every Claude + Voyage call nested in
      // runAgent is captured and debited once the turn completes.
      ({ result: agentResult, meter: turnMeter } = await withMeter(
        { userId: user.id, feature: "chat" },
        async () => {
          const r = await runAgent({
            userMessage,
            history: conversationHistory,
            sessionStore: sessionStoreForTurn!,
            sessionFilters,
            // The turn's own signal, NOT the request's. Only an explicit Stop
            // (or an orphan check in `flush`) reaches this now.
            abortSignal: turn.abort.signal,
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
            // The gate retracted optimistically-released text; tell the
            // client to drop what it has rendered for this message.
            onRollback: () => send("rollback", {}),
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
      // Only an explicit Stop can land here as an abort now — a client that
      // merely went away no longer touches this signal. The meter was already
      // marked unbillable inside withMeter when runAgent threw, so the user
      // isn't charged. Persist it quietly without a scary log/banner.
      if (err instanceof AgentAbortedError || turn.abort.signal.aborted) {
        status = "error";
        errorMsg = "cancelled";
        // Keep whatever was written before Stop. With nothing written, say so
        // in prose — this row is read back on every future load of the chat,
        // where a bare "(cancelled)" marker reads as a glitch.
        assistantContent =
          assistantContent || turn.content || "Stopped before an answer was written.";
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

    // One event per completed turn, whatever the outcome — `status` already
    // distinguishes success / degraded / error, and splitting them into
    // separate events would make the funnel harder to read, not easier.
    track(status === "error" ? EVENTS.RESEARCH_FAILED : EVENTS.RESEARCH_ANSWERED, {
      userId: user.id,
      properties: {
        status,
        response_time_ms: responseTimeMs,
        steps_used: agentResult?.stepsUsed ?? 0,
        stop_reason: agentResult?.stopReason ?? null,
        cases_cited: citedCasesForDb.length,
        credits_charged: turnMeter?.credits ?? 0,
        cancelled: errorMsg === "cancelled",
        citation_mismatches: citationMismatches.length,
        // Whether the per-question credit ceiling cut this turn's research
        // short. runAgent has always computed it and nothing ever read it, so
        // there was no way to tell how often answers were being narrowed — and
        // the measured average chat turn (~28 credits) sits ABOVE the 25-credit
        // default, so it may be firing on a large share of turns rather than
        // acting as the tail-guard it was written to be. Record the threshold
        // alongside the flag: it is env-tunable, so the flag alone is not
        // interpretable after the fact.
        budget_hit: agentResult?.budgetHit ?? false,
        credit_budget: agentResult?.creditBudget ?? null,
      },
    });

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
      budget_hit: agentResult?.budgetHit ?? false,
      credit_budget: agentResult?.creditBudget ?? null,
      warnings: {
        citationMismatches: citationMismatches.length,
        citationUpgrades,
        faithfulness,
        revised: agentResult?.faithfulness?.revised ?? false,
      },
    };

    // Finalize the row that has been accumulating all along. Stop the durability
    // loop first so a late tick can't overwrite the final content with a partial
    // snapshot or resurrect status='pending'.
    stopFlushing(turn);
    let persisted = true;
    try {
      await pool.query(
        `UPDATE chat_messages
            SET content = $1,
                cited_cases = $2,
                search_results = $3,
                context_sent = $4,
                model = $5,
                token_usage = $6,
                response_time_ms = $7,
                error = $8,
                status = $9,
                rag_trace = $10,
                live_state = NULL,
                heartbeat_at = NULL
          WHERE id = $11`,
        [
          assistantContent,
          JSON.stringify(citedCasesForDb),
          agentResult
            ? JSON.stringify(
                agentResult.toolTrace.map((t) => ({
                  tool: t.tool,
                  duration_ms: t.duration_ms,
                  data: t.data,
                }))
              )
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
          turn.messageId,
        ]
      );
    } catch (err) {
      persisted = false;
      logError({
        category: "database",
        message: `failed to persist assistant message: ${err instanceof Error ? err.message : String(err)}`,
        error: err,
        severity: "critical",
        userId: user.id,
        endpoint: "/api/chat/sessions/[id]/messages",
        method: "POST",
        metadata: { sessionId, messageId: turn.messageId },
      });
    }

    if (persisted && sessionStoreForTurn) {
      try {
        const steps = buildAgentAuditSteps({
          userMessage,
          sessionStore: sessionStoreForTurn,
          toolTrace: agentResult?.toolTrace ?? [],
          phaseTrace: agentResult?.phaseTrace ?? [],
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
        await persistPipelineAudit(turn.messageId, steps, []);
      } catch (err) {
        // The audit trail is diagnostics, not the answer. Losing it must not
        // take the terminal event down with it.
        logError({
          category: "database",
          message: `failed to persist pipeline audit: ${err instanceof Error ? err.message : String(err)}`,
          error: err,
          severity: "warning",
          userId: user.id,
          metadata: { sessionId, messageId: turn.messageId },
        });
      }
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

    endTurn(turn, {
      message_id: turn.messageId,
      status,
      // Carry the reason with the terminal event so the client can render the
      // failed state on this very turn, matching what a later reload will
      // read back off the row.
      error: errorMsg,
      response_time_ms: responseTimeMs,
      steps_used: agentResult?.stepsUsed ?? 0,
      stop_reason: agentResult?.stopReason ?? null,
      // Authoritative final text. Inline markers were normalized to the caret
      // form AFTER streaming, so the client must replace its token-accumulated
      // content with this for citations to render as clickable links.
      content: assistantContent,
    });
  } catch (err) {
    // Nothing above should throw, but a floating task that dies silently would
    // leave the row pending until the reaper notices. Close it out here.
    logError({
      category: "chat",
      message: `chat turn runner crashed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "critical",
      userId: user.id,
      metadata: { sessionId, messageId: turn.messageId },
    });
    await abandonTurn(turn);
  } finally {
    // Belt and braces: endTurn/abandonTurn release it too, but a turn must never
    // end still holding the session's advisory lock — the next message in this
    // conversation would block forever.
    releaseTurnLock(turn);
  }
}
