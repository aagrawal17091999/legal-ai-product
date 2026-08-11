"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAuth } from "./useAuth";
import { useCreditsContext } from "@/components/credits/CreditsProvider";
import { reportError } from "@/lib/report-error";
import type { ChatSession, ChatMessage, SearchFilters, CitedCase } from "@/types";

const SESSIONS_CACHE_PREFIX = "nyaya:sessions:";
const MESSAGES_CACHE_PREFIX = "nyaya:messages:";

// What the agent is doing right now, in user-facing words. Drafts are not
// streamed token-by-token (the agent searches → verifies → only then streams
// the accepted answer), so this status line is the only feedback during the
// long pre-answer phase — it keeps a waiting user from assuming the app stalled.
const DEFAULT_SEARCH_STATUS = "Searching case law…";

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
  const [isLoading, setIsLoading] = useState(false);
  // Live "what the agent is doing" text shown next to the loading spinner.
  // null falls back to DEFAULT_SEARCH_STATUS in the UI.
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
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
  // Tracks the session id currently receiving streamed tokens. loadSession
  // skips when targeting this session so a token-refresh re-render can't
  // clobber the in-flight assistant bubble.
  const streamingSessionRef = useRef<string | null>(null);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }, [getToken]);

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
          return session;
        }
        return null;
      } catch (err) {
        reportError("Failed to create chat session", { hook: "useChat.createSession" }, err);
        return null;
      }
    },
    [authHeaders, user]
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      if (streamingSessionRef.current === sessionId) return;

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
          if (streamingSessionRef.current === sessionId) return;
          setCurrentSession(data.session);
          setMessages(data.messages);
          writeCachedMessages(sessionId, data.messages);
        }
      } catch (err) {
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
          return true;
        }
        return false;
      } catch (err) {
        reportError("Failed to delete chat session", { hook: "useChat.deleteSession", sessionId }, err);
        return false;
      }
    },
    [authHeaders, currentSession, user]
  );

  const sendMessage = useCallback(
    async (message: string): Promise<boolean> => {
      if (!currentSession) return false;

      setIsLoading(true);
      setSearchStatus(null);
      setError(null);

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

      const controller = new AbortController();
      abortControllerRef.current = controller;
      streamingSessionRef.current = currentSession.id;

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
          setMessages((prev) => prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId));
          setError("Failed to send message. Please try again.");
          return false;
        }

        // Parse the SSE stream.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const applyEvent = (event: string, data: unknown) => {
          if (event === "token") {
            const delta = (data as { delta?: string }).delta ?? "";
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAssistantId ? { ...m, content: m.content + delta } : m
              )
            );
          } else if (event === "tool") {
            // Each tool call announces itself; reflect the latest one in the
            // status line so the user sees real, changing activity.
            const d = data as { phase?: string; tool?: string };
            if (d.phase === "start" && d.tool) {
              setSearchStatus(labelForTool(d.tool));
            }
          } else if (event === "status") {
            const phase = (data as { phase?: string }).phase;
            if (phase) setSearchStatus(labelForPhase(phase));
          } else if (event === "cases") {
            const cases = (data as CitedCase[]) ?? [];
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAssistantId ? { ...m, cited_cases: cases } : m
              )
            );
          } else if (event === "title") {
            const title = (data as { title?: string }).title;
            if (title) {
              setSessions((prev) => {
                const next = prev.map((s) =>
                  s.id === currentSession.id
                    ? { ...s, title, updated_at: new Date().toISOString() }
                    : s
                );
                if (user) writeCachedSessions(user.uid, next);
                return next;
              });
              setCurrentSession((cur) =>
                cur && cur.id === currentSession.id ? { ...cur, title } : cur
              );
            }
          } else if (event === "done") {
            const d = data as {
              message_id?: string | null;
              status?: "success" | "error" | "degraded";
              response_time_ms?: number;
              content?: string;
            };
            setMessages((prev) => {
              const next = prev.map((m) =>
                m.id === tempAssistantId
                  ? {
                      ...m,
                      id: d.message_id || m.id,
                      status: d.status || m.status,
                      response_time_ms: d.response_time_ms ?? m.response_time_ms,
                      // Replace token-accumulated text with the server's final
                      // version (citation markers normalized to the caret form
                      // + any validation/groundedness footers) so citations
                      // render as clickable links without a reload.
                      content: d.content ?? m.content,
                    }
                  : m.id === tempUserId
                  ? { ...m, id: `user-${crypto.randomUUID()}` }
                  : m
              );
              // Persist the completed turn so reopening this chat paints instantly.
              writeCachedMessages(currentSession.id, next);
              return next;
            });
          } else if (event === "error") {
            const msg = (data as { message?: string }).message || "Unknown error";
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAssistantId
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
            setError(msg);
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

        return true;
      } catch (err) {
        // User-initiated abort — keep any partial assistant content, mark stopped.
        if (err instanceof DOMException && err.name === "AbortError") {
          setMessages((prev) =>
            prev
              .filter((m) => !(m.id === tempAssistantId && m.content === ""))
              .map((m) =>
                m.id === tempAssistantId
                  ? { ...m, status: "success", id: `assistant-${crypto.randomUUID()}` }
                  : m.id === tempUserId
                  ? { ...m, id: `user-${crypto.randomUUID()}` }
                  : m
              )
          );
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
            m.id === tempAssistantId
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
        if (streamingSessionRef.current === currentSession.id) {
          streamingSessionRef.current = null;
        }
        setIsLoading(false);
        setSearchStatus(null);
        // Every turn spends credits, so the header meter is stale the moment the
        // answer lands. Refresh here (not just on 402) so a user watches the
        // balance fall and can act before being blocked.
        void refreshCredits();
      }
    },
    [currentSession, authHeaders, user, handlePaymentRequired, refreshCredits]
  );

  const stopMessage = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

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
