/**
 * Document chat: the durable-turn adapter.
 *
 * The engine in lib/turns/durableTurns.ts owns streaming, durability and
 * liveness; this file owns what is specific to a doc-chat turn — writing the
 * user + pending assistant rows, running runDocChat, finalizing the row, and
 * the workspace/conversation bookkeeping that follows.
 *
 * Doc chat's version of the refresh bug was quieter than case-law chat's: this
 * route never handed `request.signal` to the model, so an answer survived a
 * reload and simply appeared, complete, on the next read. But the turn was
 * still owned by the request — no way to watch it finish, no Stop, and a proxy
 * timeout mid-answer left a half-written bubble. It runs on the same engine now.
 */
import pool from "@/lib/db";
import { withMeter, markMeterUnbillable } from "@/lib/billing/meter";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import { runDocChat, type DocChatTurn, type DocCitation } from "@/lib/docchat/answer";
import { DocAgentAbortedError } from "@/lib/docchat/docAgent";
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

export { streamNewTurn, SSE_HEADERS } from "@/lib/turns/durableTurns";

/** Where doc-chat turns live, and what this stream calls its citation payload. */
export const DOC_TURNS: TurnTable = {
  table: "workspace_messages",
  threadColumn: "conversation_id",
  citationsColumn: "citations",
  citationsEvent: "citations",
  interruptedText:
    "This answer was interrupted before it could be written. Please ask again.",
};

/** Attach to a doc-chat turn, resuming from the text the client already has. */
export function attachToTurn(messageId: string, fromOffset: number) {
  return attachToTurnGeneric(DOC_TURNS, messageId, fromOffset);
}

/** Stop a doc-chat turn — an explicit act, not a closed connection. */
export function requestStop(messageId: string): Promise<void> {
  return requestStopGeneric(DOC_TURNS, messageId);
}

/** Fail doc-chat turns whose runner died. */
export function reapStaleTurns(conversationId?: string): Promise<number> {
  return reapStaleTurnsGeneric(DOC_TURNS, conversationId);
}

export interface StartDocTurnParams {
  userId: number;
  workspaceId: string;
  conversationId: string;
  userMessage: string;
  /** Whether the conversation still needs a title derived from this message. */
  needsTitle: boolean;
  /**
   * The connection holding this conversation's advisory lock. Ownership
   * transfers to the engine, which releases it on every exit path.
   */
  lockClient: { release(): void };
}

/**
 * Write both rows, register the turn, and kick the agent off detached. Returns
 * as soon as the assistant row exists, so the caller can hand the client a
 * message id to stream from — and to reattach to later.
 */
export async function startDocTurn(
  params: StartDocTurnParams
): Promise<{ messageId: string }> {
  const { userId, workspaceId, conversationId, userMessage, needsTitle, lockClient } =
    params;

  // History for the prompt. `status <> 'pending'` skips any half-written turn an
  // earlier crash left behind — the advisory lock rules out a live one.
  const { rows: historyRows } = await pool.query(
    `SELECT role, content FROM workspace_messages
      WHERE conversation_id = $1 AND status <> 'pending'
      ORDER BY created_at ASC`,
    [conversationId]
  );
  const history: DocChatTurn[] = historyRows.map((r) => ({
    role: r.role,
    content: r.content,
  }));

  await pool.query(
    `INSERT INTO workspace_messages (workspace_id, conversation_id, role, content)
     VALUES ($1, $2, 'user', $3)`,
    [workspaceId, conversationId, userMessage]
  );

  // Auto-title an untitled conversation from its first user message.
  if (needsTitle && history.length === 0) {
    await pool.query(
      `UPDATE workspace_conversations SET title = $2 WHERE id = $1 AND title IS NULL`,
      [conversationId, userMessage.trim().slice(0, 80)]
    );
  }

  // The assistant row exists before a single token does. This is what makes the
  // turn discoverable after a reload: the conversation load sees a 'pending' row
  // and reattaches to it.
  const startedAt = new Date().toISOString();
  const { rows: pendingRows } = await pool.query<{ id: string }>(
    `INSERT INTO workspace_messages
       (workspace_id, conversation_id, role, content, status, heartbeat_at, live_state)
     VALUES ($1, $2, 'assistant', '', 'pending', NOW(), $3)
     RETURNING id`,
    [workspaceId, conversationId, JSON.stringify({ started_at: startedAt })]
  );
  const messageId = pendingRows[0].id;

  const turn = beginTurn({
    table: DOC_TURNS,
    messageId,
    lock: lockClient,
    context: { workspaceId, conversationId, userId },
  });

  // Floating on purpose — this is the whole point. `runDocTurn` never rejects.
  void runDocTurn({
    turn,
    userId,
    workspaceId,
    conversationId,
    userMessage,
    history,
    startedAt,
  });

  return { messageId };
}

interface RunDocTurnParams {
  turn: LiveTurn;
  userId: number;
  workspaceId: string;
  conversationId: string;
  userMessage: string;
  history: DocChatTurn[];
  startedAt: string;
}

async function runDocTurn(p: RunDocTurnParams): Promise<void> {
  const { turn, userId, workspaceId, conversationId, userMessage, history, startedAt } = p;

  const tStart = Date.parse(startedAt);
  let assistantContent = "";
  let citations: DocCitation[] = [];
  let status: "success" | "error" | "degraded" = "success";
  let errorMsg: string | null = null;
  let model: string | null = null;
  // Whether the per-question credit ceiling stopped the agent researching early,
  // and the ceiling in force. Only reachable via analytics — workspace_messages
  // has no trace column.
  let budgetHit = false;
  let creditBudget: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  // Streaming, buffering and durability all live in the engine; this adapter
  // just emits.
  const send = (event: string, data: unknown) => turn.send(event, data);

  try {
    track(EVENTS.DOCCHAT_ASKED, {
      userId,
      properties: { message_length: userMessage.length, history_turns: history.length },
    });

    let turnMeter: Awaited<ReturnType<typeof withMeter>>["meter"] | null = null;
    try {
      // Meter the whole doc-chat turn (analyze + retrieve/embed/rerank + the
      // streamed answer + citation verify) and debit when it finalizes.
      const { result, meter } = await withMeter(
        { userId, feature: "workspace_chat" },
        async () => {
          const r = await runDocChat({
            workspaceId,
            userMessage,
            history,
            // The turn's own signal, NOT the request's. Only an explicit Stop
            // (or the engine finding the row orphaned) reaches this.
            abortSignal: turn.signal,
            onTextDelta: (delta) => send("token", { delta }),
            onStatus: (s) => send("status", s),
          });
          // Don't bill a turn that produced no usable answer (empty stream /
          // aborted mid-flight) — the user got nothing back. withMeter already
          // auto-skips the charge when runDocChat throws.
          if (!r.assistantContent || !r.assistantContent.trim()) {
            markMeterUnbillable();
          }
          return r;
        }
      );
      turnMeter = meter;
      assistantContent = result.assistantContent;
      citations = result.citations;
      model = result.model;
      budgetHit = result.budgetHit;
      creditBudget = result.creditBudget;
      inputTokens = result.tokens.input;
      outputTokens = result.tokens.output;

      // A turn that completed without producing any text is a failure the user
      // has to be told about — silently rendering an empty bubble is the "looks
      // like it worked until you reload" case. Mark it degraded, say so in the
      // bubble, and record why on the row.
      if (!assistantContent.trim()) {
        status = "degraded";
        errorMsg = "The assistant did not produce an answer.";
        assistantContent =
          "Sorry, I couldn't produce an answer from your documents. Please rephrase your question and try again.";
        send("token", { delta: assistantContent });
        logError({
          category: "chat",
          message: "Doc chat produced an empty response",
          severity: "warning",
          userId,
          endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
          method: "POST",
          metadata: { workspaceId, conversationId },
        });
      }
      send("citations", citations);
    } catch (err) {
      // Only an explicit Stop can land here as an abort — a client that merely
      // went away no longer touches this signal. The meter was already marked
      // unbillable inside withMeter when runDocChat threw, so the user isn't
      // charged. Persist it quietly without a scary log/banner.
      if (err instanceof DocAgentAbortedError || turn.signal.aborted) {
        status = "error";
        errorMsg = "cancelled";
        // Keep whatever was written before Stop. With nothing written, say so in
        // prose — this row is read back on every future load of the chat, where
        // a bare marker reads as a glitch.
        assistantContent =
          assistantContent || turn.content || "Stopped before an answer was written.";
      } else {
        status = "error";
        errorMsg = err instanceof Error ? err.message : String(err);
        assistantContent =
          assistantContent ||
          "Sorry, I encountered an error answering from your documents. Please try again.";
        logError({
          category: "chat",
          message: `Doc chat failed: ${errorMsg}`,
          error: err,
          userId,
          endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
          method: "POST",
          metadata: { workspaceId, conversationId },
        });
        send("error", { message: errorMsg });
      }
    }

    const responseTimeMs = Date.now() - tStart;

    track(EVENTS.DOCCHAT_ANSWERED, {
      userId,
      properties: {
        response_time_ms: responseTimeMs,
        citations: citations.length,
        credits_charged: turnMeter?.credits ?? 0,
        answered: Boolean(assistantContent?.trim()),
        // See the research agent's equivalent: the ceiling was invisible, and
        // workspace_messages has no trace column to persist it to, so the
        // analytics event is the only place it can be measured.
        budget_hit: budgetHit,
        credit_budget: creditBudget,
      },
    });

    // Finalize the row that has been accumulating all along. Stop the durability
    // loop first so a late tick can't overwrite the final content with a partial
    // snapshot or resurrect status='pending'.
    stopFlushing(turn);
    try {
      await pool.query(
        `UPDATE workspace_messages
            SET content = $1, citations = $2, model = $3, token_usage = $4,
                response_time_ms = $5, status = $6, error = $7,
                live_state = NULL, heartbeat_at = NULL
          WHERE id = $8`,
        [
          assistantContent,
          JSON.stringify(citations),
          model,
          inputTokens !== null && outputTokens !== null
            ? JSON.stringify({ input_tokens: inputTokens, output_tokens: outputTokens })
            : null,
          responseTimeMs,
          status,
          errorMsg,
          turn.messageId,
        ]
      );
      await pool.query(
        `UPDATE workspace_conversations SET updated_at = NOW() WHERE id = $1`,
        [conversationId]
      );
      await pool.query(`UPDATE workspaces SET updated_at = NOW() WHERE id = $1`, [
        workspaceId,
      ]);
      // Credits debited by withMeter() above — no per-question counter.
    } catch (err) {
      logError({
        category: "database",
        message: `failed to persist workspace message: ${err instanceof Error ? err.message : String(err)}`,
        error: err,
        severity: "critical",
        userId,
        endpoint: "/api/workspace/[id]/conversations/[cid]/messages",
        metadata: { workspaceId, conversationId, messageId: turn.messageId },
      });
    }

    endTurn(turn, {
      message_id: turn.messageId,
      status,
      // Carry the reason so the client can show the failure inline on the very
      // turn that failed, not only after a reload re-reads the row.
      error: errorMsg,
      response_time_ms: responseTimeMs,
      content: assistantContent,
    });
  } catch (err) {
    // Nothing above should throw, but a floating task that dies silently would
    // leave the row pending until the reaper notices. Close it out here.
    logError({
      category: "chat",
      message: `doc chat turn runner crashed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "critical",
      userId,
      metadata: { workspaceId, conversationId, messageId: turn.messageId },
    });
    await abandonTurn(turn);
  } finally {
    // Belt and braces: endTurn/abandonTurn release it too, but a turn must never
    // end still holding the conversation's advisory lock.
    releaseTurnLock(turn);
  }
}
