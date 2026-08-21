"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAuth } from "./useAuth";
import { useCreditsContext } from "@/components/credits/CreditsProvider";
import { reportError } from "@/lib/report-error";
import { userFacingError } from "@/lib/user-error";
import type { ChatSession, ChatMessage, SearchFilters, CitedCase } from "@/types";

const SESSIONS_CACHE_PREFIX = "nyaya:sessions:";
const MESSAGES_CACHE_PREFIX = "nyaya:messages:";

// What the agent is doing right now, in user-facing words. The answer arrives a
// verified paragraph at a time rather than token-by-token (each paragraph is
// graded against its cited cases before it is released), so this status line is
// the only feedback during research and while the first paragraph is being
// written — it keeps a waiting user from assuming the app stalled.
const DEFAULT_SEARCH_STATUS = "Searching case law…";

// Reattach budget. The turn survives on the server, so a dropped connection is
// worth retrying a few times before telling the user anything is wrong.
const ATTACH_MAX_ATTEMPTS = 4;
const ATTACH_RETRY_MS = 750;

// Map a tool's start event to what the user should think is happening.
function labelForTool(tool: string): string {
  switch (tool) {
    case "search_fresh":
      return "Searching case law…";
    case "lookup_by_citation":
      return "Looking up the citation…";
    case "load_case":
      return "Reading the judgment…";
    case "expand_cited_cases":
      return "Following cited cases…";
    case "list_session_cases":
      return "Reviewing your cases…";
    default:
      return DEFAULT_SEARCH_STATUS;
  }
}

// Map an agent status phase to user-facing words.
function labelForPhase(phase: string): string {
  switch (phase) {
    case "researching":
      return "Searching for more on-point cases…";
    case "verifying":
      return "Verifying citations…";
    // The stretch between the last tool call and the verified answer is the
    // longest part of a research turn. Without these the status line sat on
    // whichever tool ran last for minutes, reading as a hang.
    case "writing":
      return "Writing the answer…";
    case "revising":
      return "Correcting unsupported citations…";
    default:
      return DEFAULT_SEARCH_STATUS;
  }
}

function readCachedSessions(uid: string): ChatSession[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSIONS_CACHE_PREFIX + uid);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedSessions(uid: string, sessions: ChatSession[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SESSIONS_CACHE_PREFIX + uid,
      JSON.stringify(sessions)
    );
  } catch {
    /* quota or disabled storage — ignore */
  }
}

function readCachedMessages(sessionId: string): ChatMessage[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MESSAGES_CACHE_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedMessages(sessionId: string, messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      MESSAGES_CACHE_PREFIX + sessionId,
      JSON.stringify(messages)
    );
  } catch {
    /* quota or disabled storage — ignore */
  }
}

export function useChat() {
  const { getToken, user, loading: authLoading } = useAuth();
  const { handlePaymentRequired, refresh: refreshCredits } = useCreditsContext();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // WHICH sessions are mid-answer, not merely THAT one is. A turn now outlives
  // navigation between chats, so a single boolean showed the spinner on
  // whichever conversation the user happened to switch to. Kept as state (not
  // just the ref below) because the UI has to re-render when it changes.
  const [streamingSessions, setStreamingSessions] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // Live "what the agent is doing" text shown next to the loading spinner.
  // null falls back to DEFAULT_SEARCH_STATUS in the UI.
  const [searchStatusBySession, setSearchStatusBySession] = useState<
    Record<string, string | null>
  >({});
  // True while a session's messages are being fetched and we have nothing
  // cached to show yet — drives the skeleton so the empty "new chat" state
  // never flashes when opening an existing conversation.
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionsLoadedRef = useRef(false);
  // Latest sessions list, readable synchronously inside loadSession without
  // adding `sessions` to its dependency array.
  const sessionsRef = useRef<ChatSession[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  // Session ids currently receiving streamed tokens. loadSession skips these so
  // a token-refresh re-render can't clobber an in-flight assistant bubble. Held
  // in a ref as well as state because the guards need it synchronously, before
  // React has re-rendered.
  const streamingSessionsRef = useRef<Set<string>>(new Set());
  // The status line is per-session too: "Verifying citations…" from a chat the
  // user has navigated away from must not narrate the one they are reading.
  const setPhase = useCallback((sessionId: string, label: string | null) => {
    setSearchStatusBySession((prev) =>
      prev[sessionId] === label ? prev : { ...prev, [sessionId]: label }
    );
  }, []);
  const beginStreaming = useCallback((sessionId: string) => {
    streamingSessionsRef.current.add(sessionId);
    setStreamingSessions(new Set(streamingSessionsRef.current));
  }, []);
  const endStreaming = useCallback((sessionId: string) => {
    streamingSessionsRef.current.delete(sessionId);
    setStreamingSessions(new Set(streamingSessionsRef.current));
    setSearchStatusBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);
  // The session on screen, readable inside a stream handler that may outlive
  // the user's presence on it.
  const currentSessionRef = useRef<string | null>(null);
  useEffect(() => {
    currentSessionRef.current = currentSession?.id ?? null;
  }, [currentSession]);
  // The turn currently being rendered, by persisted row id. Stop needs this:
  // cancelling is now a request to the server, not a closed socket.
  const activeTurnRef = useRef<{ sessionId: string; messageId: string } | null>(null);
  // Stop pressed in the sub-second window before the server announced the
  // turn's id; replayed as soon as it arrives.
  const stopRequestedRef = useRef(false);
  // Turn ids we have already reattached to, so the pending-row effect doesn't
  // open a second stream onto the same answer on every re-render.
  const followedTurnsRef = useRef<Set<string>>(new Set());
  // Latest messages, readable synchronously so a reattach can compute how much
  // of the answer it already has without re-creating the callback each render.
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }, [getToken]);

  // Ask the server to stop a turn. Detaching the stream would no longer do it —
  // the whole point of the change — so Stop has to be an explicit call.
  const postStop = useCallback(
    async (sessionId: string, messageId: string) => {
      try {
        const headers = await authHeaders();
        await fetch(`/api/chat/sessions/${sessionId}/turns/${messageId}/stop`, {
          method: "POST",
          headers,
        });
      } catch (err) {
        reportError(
          "Failed to stop chat turn",
          { hook: "useChat.stopMessage", sessionId, messageId },
          err
        );
      }
    },
    [authHeaders]
  );

  const loadSessions = useCallback(async () => {
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/chat/sessions", { headers });
      if (res.ok) {
        const data: ChatSession[] = await res.json();
        setSessions(data);
        if (user) writeCachedSessions(user.uid, data);
      }
    } catch (err) {
      reportError("Failed to load chat sessions", { hook: "useChat.loadSessions" }, err);
    }
  }, [authHeaders, user]);

  // Hydrate sessions from localStorage the moment we know the user, so the
  // sidebar paints with real content on the very first frame instead of
  // waiting for the network round-trip. Then revalidate in the background.
  useEffect(() => {
    if (user && !authLoading && !sessionsLoadedRef.current) {
      sessionsLoadedRef.current = true;
      const cached = readCachedSessions(user.uid);
      if (cached && cached.length > 0) {
        setSessions(cached);
      }
      loadSessions();
    }
  }, [user, authLoading, loadSessions]);

  const createSession = useCallback(
    async (filters: SearchFilters): Promise<ChatSession | null> => {
      try {
        const headers = await authHeaders();
        const res = await fetch("/api/chat/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({ filters }),
        });
        if (res.ok) {
          const session = await res.json();
          setSessions((prev) => {
            const next = [session, ...prev];
            if (user) writeCachedSessions(user.uid, next);
            return next;
          });
          setCurrentSession(session);
          setMessages([]);
          setError(null);
          return session;
        }
        // A silent null here left the user clicking "Start research" with
        // nothing happening at all. Say what failed, and record it.
        const data = await res.json().catch(() => ({} as Record<string, unknown>));
        const msg =
          typeof data.error === "string"
            ? data.error
            : "Couldn't start a new chat. Please try again.";
        setError(msg);
        reportError("Failed to create chat session", {
          hook: "useChat.createSession",
          http_status: res.status,
        });
        return null;
      } catch (err) {
        setError("Couldn't reach the server. Check your connection and try again.");
        reportError("Failed to create chat session", { hook: "useChat.createSession" }, err);
        return null;
      }
    },
    [authHeaders, user]
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      if (streamingSessionsRef.current.has(sessionId)) return;

      // Paint instantly from cache if we've seen this chat before, then
      // revalidate in the background — the same SWR pattern the sidebar uses.
      const cached = readCachedMessages(sessionId);
      if (cached) {
        setCurrentSession(
          (cur) =>
            sessionsRef.current.find((s) => s.id === sessionId) ?? cur
        );
        setMessages(cached);
        setSessionLoading(false);
      } else {
        // No cache: clear the previous chat's messages and show the skeleton
        // instead of the "What are you researching today?" empty state.
        setMessages([]);
        setSessionLoading(true);
      }

      try {
        const headers = await authHeaders();
        const res = await fetch(`/api/chat/sessions/${sessionId}`, { headers });
        if (res.ok) {
          const data = await res.json();
          if (streamingSessionsRef.current.has(sessionId)) return;
          setCurrentSession(data.session);
          setMessages(data.messages);
          writeCachedMessages(sessionId, data.messages);
          setError(null);
        } else {
          // Previously swallowed: a failed load left an empty thread that looked
          // like a brand-new chat. Tell the user the history couldn't be read.
          setError(
            res.status === 404
              ? "This conversation no longer exists."
              : "Couldn't load this conversation. Please refresh and try again."
          );
          reportError("Failed to load chat session", {
            hook: "useChat.loadSession",
            sessionId,
            http_status: res.status,
          });
        }
      } catch (err) {
        setError("Couldn't reach the server. Check your connection and try again.");
        reportError("Failed to load chat session", { hook: "useChat.loadSession", sessionId }, err);
      } finally {
        setSessionLoading(false);
      }
    },
    [authHeaders]
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        const headers = await authHeaders();
        const res = await fetch(`/api/chat/sessions/${sessionId}`, {
          method: "DELETE",
          headers,
        });
        if (res.ok) {
          setSessions((prev) => {
            const next = prev.filter((s) => s.id !== sessionId);
            if (user) writeCachedSessions(user.uid, next);
            return next;
          });
          if (currentSession?.id === sessionId) {
            setCurrentSession(null);
            setMessages([]);
          }
          setError(null);
          return true;
        }
        // Previously silent: the conversation stayed in the sidebar with no hint
        // that the delete had failed.
        setError("Couldn't delete that conversation. Please try again.");
        reportError("Failed to delete chat session", {
          hook: "useChat.deleteSession",
          sessionId,
          http_status: res.status,
        });
        return false;
      } catch (err) {
        setError("Couldn't reach the server. Check your connection and try again.");
        reportError("Failed to delete chat session", { hook: "useChat.deleteSession", sessionId }, err);
        return false;
      }
    },
    [authHeaders, currentSession, user]
  );

  // Parse one SSE turn stream and fold its events into `messages`. Shared by
  // the POST that starts a turn and by every reattach, so a reconnected client
  // renders exactly what a first-time one does.
  //
  // Returns whether a terminal event arrived. A stream that ends WITHOUT one no
  // longer means the answer died — the turn runs detached from this connection
  // now, so the caller reattaches instead of declaring failure.
  const consumeTurn = useCallback(
    async (
      res: Response,
      opts: { sessionId: string; assistantId: string; tempUserId?: string | null }
    ): Promise<{ terminal: boolean; assistantId: string }> => {
      const { sessionId, tempUserId } = opts;
      // Reassigned when the server announces the real row id, so every later
      // event targets the persisted message rather than the optimistic one.
      let assistantId = opts.assistantId;
      let sawTerminalEvent = false;

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const applyEvent = (event: string, data: unknown) => {
        if (event === "turn") {
          const realId = (data as { message_id?: string }).message_id;
          if (realId && realId !== assistantId) {
            const previousId = assistantId;
            assistantId = realId;
            setMessages((prev) =>
              prev.map((m) => (m.id === previousId ? { ...m, id: realId } : m))
            );
          }
          if (realId) {
            activeTurnRef.current = { sessionId, messageId: realId };
            // Stop was pressed before we knew the id — send it now.
            if (stopRequestedRef.current) {
              stopRequestedRef.current = false;
              void postStop(sessionId, realId);
            }
          }
        } else if (event === "token") {
          const delta = (data as { delta?: string }).delta ?? "";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + delta } : m
            )
          );
        } else if (event === "rollback") {
          // The server released verified paragraphs optimistically and then
          // had to take them back (the model called a tool after all). Clear
          // the provisional text; the real answer streams in after it.
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: "" } : m))
          );
        } else if (event === "tool") {
          // Each tool call announces itself; reflect the latest one in the
          // status line so the user sees real, changing activity.
          const d = data as { phase?: string; tool?: string };
          if (d.phase === "start" && d.tool) {
            setPhase(sessionId, labelForTool(d.tool));
          }
        } else if (event === "status") {
          const phase = (data as { phase?: string }).phase;
          if (phase) setPhase(sessionId, labelForPhase(phase));
        } else if (event === "cases") {
          const cases = (data as CitedCase[]) ?? [];
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, cited_cases: cases } : m))
          );
        } else if (event === "title") {
          const title = (data as { title?: string }).title;
          if (title) {
            setSessions((prev) => {
              const next = prev.map((s) =>
                s.id === sessionId
                  ? { ...s, title, updated_at: new Date().toISOString() }
                  : s
              );
              if (user) writeCachedSessions(user.uid, next);
              return next;
            });
            setCurrentSession((cur) =>
              cur && cur.id === sessionId ? { ...cur, title } : cur
            );
          }
        } else if (event === "done") {
          sawTerminalEvent = true;
          const d = data as {
            message_id?: string | null;
            status?: "success" | "error" | "degraded";
            error?: string | null;
            response_time_ms?: number;
            content?: string;
          };
          // A turn can finish "successfully" at the HTTP level while the
          // server recorded it as failed or degraded. Surface that here so the
          // bubble matches the persisted row without a reload.
          const doneReason = userFacingError(d.error);
          // Only banner it if the user is still looking at this conversation —
          // a turn outlives navigation now, and a global banner about a chat
          // that is no longer on screen is noise. The bubble carries the failure
          // either way.
          if (d.status === "error" && doneReason && currentSessionRef.current === sessionId) {
            setError(doneReason);
          }
          // A stop is recorded as status "error" with the sentinel reason
          // "cancelled", which userFacingError deliberately maps to null (it is
          // not a failure to report). Keep the sentinel on the row so
          // MessageBubble renders a stopped turn plainly instead of as an
          // error — the client used to get this for free by aborting the fetch
          // before the terminal event arrived, and no longer does.
          const cancelled = d.error === "cancelled";
          setMessages((prev) => {
            const next = prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    id: d.message_id || m.id,
                    status: d.status || "success",
                    error: cancelled ? "cancelled" : (doneReason ?? m.error),
                    response_time_ms: d.response_time_ms ?? m.response_time_ms,
                    // Replace token-accumulated text with the server's final
                    // version (citation markers normalized to the caret form
                    // + any validation/groundedness footers) so citations
                    // render as clickable links without a reload.
                    content: d.content ?? m.content,
                  }
                : tempUserId && m.id === tempUserId
                  ? { ...m, id: `user-${crypto.randomUUID()}` }
                  : m
            );
            // Persist the completed turn so reopening this chat paints
            // instantly — but only if these really are that session's messages.
            // A turn now outlives navigation, so it can finish while `prev`
            // holds a different conversation; caching that under this session's
            // key would overwrite the wrong thread.
            if (next.some((m) => m.id === (d.message_id || assistantId))) {
              writeCachedMessages(sessionId, next);
            }
            return next;
          });
        } else if (event === "error") {
          sawTerminalEvent = true;
          // Raw provider text — sanitize before it reaches the screen. The
          // server has already persisted the full version.
          const msg =
            userFacingError((data as { message?: string }).message) ??
            "Something went wrong generating this answer. Please try again.";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    status: "error",
                    error: msg,
                    content:
                      m.content ||
                      "Sorry, I encountered an error generating a response. Please try again.",
                  }
                : m
            )
          );
          if (currentSessionRef.current === sessionId) setError(msg);
        }
      };

      // SSE frames are separated by blank lines; within a frame, `event:` and
      // `data:` lines carry the payload. We accumulate into `buffer` until we
      // see a double newline, then parse one frame at a time.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIdx: number;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);

          let ev = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) {
              ev = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          if (dataLines.length === 0) continue;
          const raw = dataLines.join("\n");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          applyEvent(ev, parsed);
        }
      }

      return { terminal: sawTerminalEvent, assistantId };
    },
    [user, postStop, setPhase]
  );

  /**
   * Follow a turn that is already running server-side, picking up from whatever
   * text we already have. Used on reload (the session load found a `pending`
   * row), and to recover a stream that dropped mid-answer.
   *
   * Retries a few times with backoff: the connection is the fragile part now,
   * not the turn, so a dropped socket deserves another attempt rather than an
   * error message.
   */
  const followTurn = useCallback(
    async (sessionId: string, messageId: string): Promise<boolean> => {
      beginStreaming(sessionId);
      if (currentSessionRef.current === sessionId) setError(null);
      activeTurnRef.current = { sessionId, messageId };

      const currentOffset = () =>
        messagesRef.current.find((m) => m.id === messageId)?.content.length ?? 0;

      try {
        for (let attempt = 0; attempt < ATTACH_MAX_ATTEMPTS; attempt++) {
          const controller = new AbortController();
          abortControllerRef.current = controller;
          try {
            const headers = await authHeaders();
            const res = await fetch(
              `/api/chat/sessions/${sessionId}/turns/${messageId}/stream?offset=${currentOffset()}`,
              { headers, signal: controller.signal }
            );

            if (res.status === 404) {
              // The turn (or the session) is gone. Fall back to a plain reload.
              return false;
            }
            if (!res.ok || !res.body) return false;

            // Not an SSE stream: the turn had already finished. The row the
            // client loaded (or is about to reload) is the whole answer.
            if (!res.headers.get("Content-Type")?.includes("text/event-stream")) {
              return false;
            }

            const { terminal } = await consumeTurn(res, {
              sessionId,
              assistantId: messageId,
            });
            if (terminal) return true;
          } catch (err) {
            // A deliberate detach (switching sessions, unmounting) — not a
            // failure, and not something to retry.
            if (err instanceof DOMException && err.name === "AbortError") return true;
            reportError(
              "Failed to follow in-progress chat turn",
              { hook: "useChat.followTurn", sessionId, attempt },
              err
            );
          }
          await new Promise((r) => setTimeout(r, ATTACH_RETRY_MS * (attempt + 1)));
        }

        // Out of attempts. The answer may well still be finishing server-side —
        // say that, rather than claiming it failed.
        if (currentSessionRef.current === sessionId) {
          setError(
            "Lost the connection to this answer. It may still be finishing — reload to pick it up."
          );
        }
        return false;
      } finally {
        endStreaming(sessionId);
        activeTurnRef.current = null;
        void refreshCredits();
      }
    },
    [authHeaders, consumeTurn, refreshCredits, beginStreaming, endStreaming]
  );

  // Reattach to an in-progress turn. This is what makes a refresh a non-event:
  // the session load returns a `status='pending'` assistant row, and we pick the
  // stream back up from the characters already on it.
  useEffect(() => {
    if (!currentSession) return;
    if (streamingSessionsRef.current.has(currentSession.id)) return;
    const pending = messages.find(
      (m) => m.role === "assistant" && m.status === "pending"
    );
    if (!pending || pending.id.startsWith("temp-")) return;
    if (followedTurnsRef.current.has(pending.id)) return;
    followedTurnsRef.current.add(pending.id);

    const sessionId = currentSession.id;
    void followTurn(sessionId, pending.id).then((ok) => {
      // Couldn't follow it — the turn finished while we were away, or was
      // reaped. Re-read the session so the bubble shows its real outcome. The
      // id stays in followedTurnsRef: if the reload still shows it pending,
      // retrying here would spin, and the user can reload.
      if (!ok) void loadSession(sessionId);
    });
  }, [currentSession, messages, followTurn, loadSession]);

  const sendMessage = useCallback(
    async (message: string): Promise<boolean> => {
      if (!currentSession) return false;

      beginStreaming(currentSession.id);
      setPhase(currentSession.id, null);
      setError(null);
      stopRequestedRef.current = false;

      // Use UUIDs (not Date.now()) so two messages created in the same tick
      // can't collide on the same temp/local id.
      const tempUserId = `temp-user-${crypto.randomUUID()}`;
      const tempAssistantId = `temp-assistant-${crypto.randomUUID()}`;

      const tempUserMsg: ChatMessage = {
        id: tempUserId,
        session_id: currentSession.id,
        role: "user",
        content: message,
        cited_cases: [],
        search_query: null,
        search_results: null,
        context_sent: null,
        model: null,
        token_usage: null,
        response_time_ms: null,
        error: null,
        status: "success",
        created_at: new Date().toISOString(),
      };
      const tempAssistantMsg: ChatMessage = {
        id: tempAssistantId,
        session_id: currentSession.id,
        role: "assistant",
        content: "",
        cited_cases: [],
        search_query: null,
        search_results: null,
        context_sent: null,
        model: null,
        token_usage: null,
        response_time_ms: null,
        error: null,
        status: "success",
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, tempUserMsg, tempAssistantMsg]);

      // This controller detaches THIS connection only. The turn it starts runs
      // server-side independently of it, so aborting here (or navigating away,
      // or refreshing) no longer cancels the answer — Stop goes through
      // stopMessage/the stop endpoint instead.
      const controller = new AbortController();
      abortControllerRef.current = controller;

      let assistantId = tempAssistantId;
      try {
        const headers = await authHeaders();
        const res = await fetch(
          `/api/chat/sessions/${currentSession.id}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ message }),
            signal: controller.signal,
          }
        );

        // Out of credits. This is the live gate (requireCredits); the 403 below
        // is the older per-plan limit. Without this branch the request fell
        // through to the generic "Failed to send message" error, which told the
        // user nothing and offered no way to fix it.
        if (handlePaymentRequired(res)) {
          setMessages((prev) => prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId));
          return false;
        }

        if (!res.ok || !res.body) {
          // Show what actually went wrong. The server sends actionable JSON here
          // — "A message is already being processed in this conversation",
          // "Session not found" — and collapsing all of it into one generic
          // sentence left the user with nothing to act on.
          const data = await res.json().catch(() => ({} as Record<string, unknown>));
          const serverMsg =
            typeof data.message === "string"
              ? data.message
              : typeof data.error === "string"
                ? data.error
                : null;
          const msg = serverMsg ?? "Failed to send message. Please try again.";
          setMessages((prev) => prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId));
          setError(msg);
          reportError(
            "Chat message request failed",
            {
              hook: "useChat.sendMessage",
              sessionId: currentSession.id,
              http_status: res.status,
              server_error: serverMsg,
            }
          );
          return false;
        }

        const outcome = await consumeTurn(res, {
          sessionId: currentSession.id,
          assistantId: tempAssistantId,
          tempUserId,
        });
        assistantId = outcome.assistantId;

        if (outcome.terminal) return true;

        // The stream ended without "done" or "error" — a proxy timeout, a
        // dropped connection, a lost socket. The TURN is still running though;
        // it is no longer tied to this request. Reattach and keep rendering
        // rather than declaring a half-written bubble failed.
        if (assistantId !== tempAssistantId) {
          followedTurnsRef.current.add(assistantId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === tempUserId ? { ...m, id: `user-${crypto.randomUUID()}` } : m
            )
          );
          return await followTurn(currentSession.id, assistantId);
        }

        // We never even learned the turn's id, so there is nothing to reattach
        // to — the request died before the server got going.
        const msg =
          "The connection to the server was lost before this answer started. Please try again.";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempAssistantId
              ? { ...m, status: "error" as const, error: msg, content: m.content || msg }
              : m.id === tempUserId
                ? { ...m, id: `user-${crypto.randomUUID()}` }
                : m
          )
        );
        setError(msg);
        reportError("Chat stream ended without a terminal event", {
          hook: "useChat.sendMessage",
          sessionId: currentSession.id,
        });
        return false;
      } catch (err) {
        // This connection was detached (session switch, unmount, refresh). The
        // turn carries on server-side and will be picked back up from its
        // pending row, so leave the bubble exactly as it is.
        if (err instanceof DOMException && err.name === "AbortError") {
          if (assistantId !== tempAssistantId) followedTurnsRef.current.delete(assistantId);
          return false;
        }
        reportError(
          "Failed to send chat message",
          { hook: "useChat.sendMessage", sessionId: currentSession.id },
          err
        );
        // The backend persists the user message unconditionally before opening
        // the stream, and may have saved the assistant message too. Don't wipe
        // local state — keep the user bubble and mark the assistant bubble as
        // errored, matching how the in-stream "error" SSE event is handled.
        const errMsg = "Something went wrong. Please check your connection and try again.";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  status: "error",
                  error: errMsg,
                  content:
                    m.content ||
                    "Sorry, I encountered an error generating a response. Please try again.",
                }
              : m.id === tempUserId
              ? { ...m, id: `user-${crypto.randomUUID()}` }
              : m
          )
        );
        setError(errMsg);
        return false;
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        endStreaming(currentSession.id);
        activeTurnRef.current = null;
        // Every turn spends credits, so the header meter is stale the moment the
        // answer lands. Refresh here (not just on 402) so a user watches the
        // balance fall and can act before being blocked.
        void refreshCredits();
      }
    },
    [
      currentSession,
      authHeaders,
      handlePaymentRequired,
      refreshCredits,
      consumeTurn,
      followTurn,
      beginStreaming,
      endStreaming,
      setPhase,
    ]
  );

  // Stop is an explicit instruction to the server now. Closing the connection
  // is no longer how a turn gets cancelled — that conflation is what made a
  // refresh kill the answer — so the Stop button has to say so out loud.
  const stopMessage = useCallback(() => {
    const active = activeTurnRef.current;
    if (!active) {
      // Pressed before the server told us the turn's id (a sub-second window).
      // Remember it and send the stop the moment the id arrives.
      stopRequestedRef.current = true;
      return;
    }
    void postStop(active.sessionId, active.messageId);
  }, [postStop]);

  // Only the conversation on screen drives its own spinner and status line.
  const isLoading = currentSession ? streamingSessions.has(currentSession.id) : false;
  const searchStatus = currentSession
    ? (searchStatusBySession[currentSession.id] ?? null)
    : null;

  return {
    sessions,
    currentSession,
    messages,
    isLoading,
    searchStatus,
    sessionLoading,
    error,
    setError,
    loadSessions,
    createSession,
    loadSession,
    deleteSession,
    sendMessage,
    stopMessage,
    setCurrentSession,
    setMessages,
    user,
    authLoading,
  };
}
