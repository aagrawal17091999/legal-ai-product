"use client";

import { useState, useCallback } from "react";
import { useAuth } from "./useAuth";
import { reportError } from "@/lib/report-error";
import type { ChatSession, ChatMessage, SearchFilters, CitedCase } from "@/types";

export function useChat() {
  const { getToken, user, loading: authLoading } = useAuth();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const data = await res.json();
        setSessions(data);
      }
    } catch (err) {
      reportError("Failed to load chat sessions", { hook: "useChat.loadSessions" }, err);
    }
  }, [authHeaders]);

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
          setSessions((prev) => [session, ...prev]);
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
    [authHeaders]
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      try {
        const headers = await authHeaders();
        const res = await fetch(`/api/chat/sessions/${sessionId}`, { headers });
        if (res.ok) {
          const data = await res.json();
          setCurrentSession(data.session);
          setMessages(data.messages);
        }
      } catch (err) {
        reportError("Failed to load chat session", { hook: "useChat.loadSession", sessionId }, err);
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
          setSessions((prev) => prev.filter((s) => s.id !== sessionId));
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
    [authHeaders, currentSession]
  );

  const sendMessage = useCallback(
    async (message: string): Promise<boolean> => {
      if (!currentSession) return false;

      setIsLoading(true);
      setLimitReached(false);
      setError(null);

      const tempUserId = `temp-user-${Date.now()}`;
      const tempAssistantId = `temp-assistant-${Date.now()}`;

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

      try {
        const headers = await authHeaders();
        const res = await fetch(
          `/api/chat/sessions/${currentSession.id}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ message }),
          }
        );

        if (res.status === 403) {
          let data: { error?: string } = {};
          try {
            data = await res.json();
          } catch {
            /* empty body */
          }
          if (data.error === "limit_reached") {
            setLimitReached(true);
            setMessages((prev) => prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId));
            return false;
          }
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
              setSessions((prev) =>
                prev.map((s) =>
                  s.id === currentSession.id
                    ? { ...s, title, updated_at: new Date().toISOString() }
                    : s
                )
              );
              setCurrentSession((cur) =>
                cur && cur.id === currentSession.id ? { ...cur, title } : cur
              );
            }
          } else if (event === "done") {
            const d = data as {
              message_id?: string | null;
              status?: "success" | "error";
              response_time_ms?: number;
            };
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAssistantId
                  ? {
                      ...m,
                      id: d.message_id || m.id,
                      status: d.status || m.status,
                      response_time_ms: d.response_time_ms ?? m.response_time_ms,
                    }
                  : m.id === tempUserId
                  ? { ...m, id: `user-${Date.now()}` }
                  : m
              )
            );
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
        reportError(
          "Failed to send chat message",
          { hook: "useChat.sendMessage", sessionId: currentSession.id },
          err
        );
        setMessages((prev) => prev.filter((m) => m.id !== tempUserId && m.id !== tempAssistantId));
        setError("Something went wrong. Please check your connection and try again.");
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [currentSession, authHeaders]
  );

  return {
    sessions,
    currentSession,
    messages,
    isLoading,
    limitReached,
    setLimitReached,
    error,
    setError,
    loadSessions,
    createSession,
    loadSession,
    deleteSession,
    sendMessage,
    setCurrentSession,
    setMessages,
    user,
    authLoading,
  };
}
