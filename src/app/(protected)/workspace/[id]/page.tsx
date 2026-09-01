"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { use as usePromise } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuth } from "@/hooks/useAuth";
import { reportError } from "@/lib/report-error";
import { userFacingError } from "@/lib/user-error";
import { useCreditsContext } from "@/components/credits/CreditsProvider";
import Spinner from "@/components/ui/Spinner";
import WorkspaceCitationPanel, { type DocCitation } from "@/components/workspace/CitationPanel";
import { MAX_FILE_LABEL } from "@/lib/uploads";

interface DocRow {
  id: string;
  filename: string;
  mime: string;
  status: "pending" | "processing" | "ready" | "failed";
  page_count: number | null;
  ocr_used: boolean;
  chunk_count: number;
  error: string | null;
}

// Reattach budget. A turn survives on the server, so a dropped connection is
// worth retrying a few times before telling the user anything is wrong.
const ATTACH_MAX_ATTEMPTS = 4;
const ATTACH_RETRY_MS = 750;

interface WsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: DocCitation[];
  /**
   * "success" | "degraded" | "error" | "pending" — mirrors
   * workspace_messages.status. A "pending" row is a turn still being written by
   * a detached runner; the page reattaches to its stream rather than rendering
   * it as a finished answer.
   */
  status: string;
  /** Why the turn failed, when it did. Persisted on the row. */
  error: string | null;
}

interface ConvSummary {
  id: string;
  title: string | null;
  message_count: number;
  updated_at: string;
}

const ACCEPT = ".pdf,.docx,.jpg,.jpeg,.png,.webp";

export default function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: workspaceId } = usePromise(params);
  const { getToken } = useAuth();
  const { handlePaymentRequired, refresh: refreshCredits } = useCreditsContext();

  const [title, setTitle] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [documents, setDocuments] = useState<DocRow[]>([]);
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [convMenuOpen, setConvMenuOpen] = useState(false);
  const [input, setInput] = useState("");
  // WHICH conversation is mid-answer, not merely THAT one is. A turn now
  // outlives navigation between chats, so a single boolean would show the
  // spinner on whichever conversation the user happened to switch to.
  const [sendingConvId, setSendingConvId] = useState<string | null>(null);
  // Transient progress text ("Reading the document…"), cleared when a turn ends.
  const [status, setStatus] = useState<string | null>(null);
  // A failure the user must keep seeing. Kept apart from `status` because that
  // is cleared in the send's `finally`, which used to wipe the error message
  // milliseconds after it appeared — the failure was effectively invisible.
  const [chatError, setChatError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [panelCitation, setPanelCitation] = useState<DocCitation | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // When polling for processing docs first started — used by the watchdog so we
  // don't poll forever if a doc is stuck pending/processing on the backend.
  const pollStartRef = useRef<number | null>(null);
  // The turn currently being rendered, by persisted row id. Stop needs it:
  // cancelling is a request to the server now, not a closed socket.
  const activeTurnRef = useRef<{ convId: string; messageId: string } | null>(null);
  // Stop pressed in the sub-second window before the server announced the
  // turn's id; replayed as soon as it arrives.
  const stopRequestedRef = useRef(false);
  // Turn ids already reattached to, so the pending-row effect doesn't open a
  // second stream onto the same answer on every re-render.
  const followedTurnsRef = useRef<Set<string>>(new Set());
  // Latest messages, readable synchronously so a reattach can work out how much
  // of the answer it already has.
  const messagesRef = useRef<WsMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // The conversation on screen, readable inside a stream handler that may
  // outlive the user's presence on it.
  const activeConvRef = useRef<string | null>(null);
  useEffect(() => {
    activeConvRef.current = activeConvId;
  }, [activeConvId]);

  // Only this conversation's turn drives this conversation's spinner.
  const sending = sendingConvId !== null && sendingConvId === activeConvId;

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return { Authorization: `Bearer ${token}` };
  }, [getToken]);

  const loadMessages = useCallback(
    async (convId: string) => {
      try {
        const res = await fetch(`/api/workspace/${workspaceId}/conversations/${convId}/messages`, {
          headers: await authHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setMessages(
            (data.messages ?? []).map((m: Record<string, unknown>) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              citations: (m.citations as DocCitation[]) ?? [],
              status: m.status,
              error: (m.error as string | null) ?? null,
            }))
          );
          // Deliberately does NOT clear `chatError`. Starting a turn in a brand
          // new conversation sets activeConvId, which fires this loader; if the
          // turn then failed fast (a 400, say) while this fetch was still in
          // flight, clearing here would erase the failure the user needs to see.
          // `chatError` is cleared only when a new turn actually starts.
        } else {
          // Previously swallowed: a failed history load rendered as an empty
          // chat, indistinguishable from a brand-new one.
          setChatError("Couldn't load this chat's history. Please refresh and try again.");
          reportError("Failed to load workspace conversation", {
            page: "workspace",
            workspaceId,
            conversationId: convId,
            http_status: res.status,
          });
        }
      } catch (err) {
        setChatError("Couldn't reach the server. Check your connection and try again.");
        reportError(
          "Failed to load workspace conversation",
          { page: "workspace", workspaceId, conversationId: convId },
          err
        );
      }
    },
    [workspaceId, authHeaders]
  );

  const loadDetail = useCallback(async () => {
    setLoadError(null);
    // Time-box the WHOLE load — including the token refresh, which can stall
    // independently of the fetch — so a hung backend or auth never leaves the
    // page on an indefinite spinner. `loaded` always flips in finally.
    const controller = new AbortController();
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, 12000)
    );
    try {
      const run = (async () => {
        const headers = await authHeaders();
        const res = await fetch(`/api/workspace/${workspaceId}`, {
          headers,
          signal: controller.signal,
        });
        if (!res.ok) {
          setLoadError("Couldn't load this workspace. Please try again.");
          return;
        }
        const data = await res.json();
        setTitle(data.workspace?.title ?? null);
        setDocuments(data.documents ?? []);
        const convs: ConvSummary[] = data.conversations ?? [];
        setConversations(convs);
        // Open the most recently updated chat by default.
        if (convs.length > 0) {
          setActiveConvId((cur) => cur ?? convs[0].id);
        }
      })();
      await Promise.race([run, deadline]);
    } catch {
      setLoadError("Couldn't reach the server. Check your connection and retry.");
    } finally {
      setLoaded(true);
    }
  }, [workspaceId, authHeaders]);

  const refreshDocs = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/documents`, {
        headers: await authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents ?? []);
        return;
      }
      // A poll that keeps failing looks identical to "still processing". Record
      // it so a wedged status endpoint is visible in error_logs rather than
      // being read as a slow document.
      reportError("Workspace document status poll failed", {
        page: "workspace",
        workspaceId,
        http_status: res.status,
      });
    } catch (err) {
      reportError("Workspace document status poll failed", { page: "workspace", workspaceId }, err);
    }
  }, [workspaceId, authHeaders]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // Load messages whenever the active conversation changes.
  useEffect(() => {
    if (activeConvId) loadMessages(activeConvId);
    else setMessages([]);
  }, [activeConvId, loadMessages]);

  // Poll while any document is still processing. The give-up point sits just
  // past the server-side stale-document watchdog (STALE_DOCUMENT_TIMEOUT_MS,
  // 15 min) so a killed ingestion is polled long enough to see the watchdog flip
  // it to `failed` — the user gets a real failure rather than this soft "still
  // processing" note, which is now only reached if the backend is wedged.
  const POLL_TIMEOUT_MS = 16 * 60 * 1000;
  useEffect(() => {
    const anyPending = documents.some((d) => d.status === "pending" || d.status === "processing");
    if (!anyPending) {
      // All settled — reset the watchdog so a future upload polls fresh.
      pollStartRef.current = null;
      setPollTimedOut(false);
      return;
    }
    if (pollStartRef.current === null) pollStartRef.current = Date.now();
    if (Date.now() - pollStartRef.current >= POLL_TIMEOUT_MS) {
      setPollTimedOut(true);
      return; // stop polling
    }
    const t = setInterval(() => {
      if (pollStartRef.current !== null && Date.now() - pollStartRef.current >= POLL_TIMEOUT_MS) {
        clearInterval(t);
        setPollTimedOut(true);
        return;
      }
      refreshDocs();
    }, 3000);
    return () => clearInterval(t);
  }, [documents, refreshDocs, POLL_TIMEOUT_MS]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch(`/api/workspace/${workspaceId}/documents`, {
        method: "POST",
        headers: await authHeaders(),
        body: form,
      });
      if (res.ok) {
        await refreshDocs();
      } else {
        const data = await res.json().catch(() => ({}));
        setUploadError(data.message || data.error || "Upload failed. Please try again.");
      }
    } catch {
      setUploadError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const startRename = () => {
    setTitleDraft(title ?? "");
    setEditingTitle(true);
  };

  const saveTitle = async () => {
    const next = titleDraft.trim();
    setSavingTitle(true);
    try {
      const token = await getToken();
      const res = await fetch(`/api/workspace/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: next }),
      });
      if (res.ok) {
        const data = await res.json();
        setTitle(data.title ?? null);
        setEditingTitle(false);
        setChatError(null);
      } else {
        // Previously silent: the field stayed in edit mode as if unclicked.
        setChatError("Couldn't rename this workspace. Please try again.");
        reportError("Failed to rename workspace", {
          page: "workspace",
          workspaceId,
          http_status: res.status,
        });
      }
    } catch (err) {
      setChatError("Couldn't reach the server. Check your connection and try again.");
      reportError("Failed to rename workspace", { page: "workspace", workspaceId }, err);
    } finally {
      setSavingTitle(false);
    }
  };

  // Open an uploaded document in a new tab via a short-lived signed URL.
  const openDocument = useCallback(
    async (documentId: string) => {
      const w = window.open("", "_blank");
      try {
        const res = await fetch(`/api/workspace/${workspaceId}/documents/${documentId}/file`, {
          headers: await authHeaders(),
        });
        if (res.ok) {
          const { url } = await res.json();
          if (w) w.location.href = url;
          return;
        }
        // The blank tab snapping shut with no message read as a popup blocker
        // or a misfired click. Say what actually happened.
        if (w) w.close();
        setChatError("Couldn't open that document. Please try again.");
        reportError("Failed to open workspace document", {
          page: "workspace",
          workspaceId,
          documentId,
          http_status: res.status,
        });
      } catch (err) {
        if (w) w.close();
        setChatError("Couldn't reach the server. Check your connection and try again.");
        reportError(
          "Failed to open workspace document",
          { page: "workspace", workspaceId, documentId },
          err
        );
      }
    },
    [workspaceId, authHeaders]
  );

  const createConversation = useCallback(async (): Promise<string | null> => {
    const res = await fetch(`/api/workspace/${workspaceId}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      reportError("Failed to create workspace conversation", {
        page: "workspace",
        workspaceId,
        http_status: res.status,
      });
      return null;
    }
    const conv = (await res.json()) as ConvSummary;
    setConversations((prev) => [conv, ...prev]);
    setActiveConvId(conv.id);
    setMessages([]);
    setPanelCitation(null);
    return conv.id;
  }, [workspaceId, authHeaders]);

  const deleteConversation = useCallback(
    async (convId: string) => {
      const res = await fetch(`/api/workspace/${workspaceId}/conversations/${convId}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      if (!res.ok) {
        // Previously silent: the chat stayed in the list with no explanation.
        setChatError("Couldn't delete that chat. Please try again.");
        reportError("Failed to delete workspace conversation", {
          page: "workspace",
          workspaceId,
          conversationId: convId,
          http_status: res.status,
        });
        return;
      }
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== convId);
        if (activeConvId === convId) setActiveConvId(next[0]?.id ?? null);
        return next;
      });
    },
    [workspaceId, authHeaders, activeConvId]
  );

  const readyCount = documents.filter((d) => d.status === "ready").length;
  const activeConv = conversations.find((c) => c.id === activeConvId) ?? null;

  // Ask the server to stop a turn. Detaching the stream no longer does it — the
  // whole point of the durable-turn change — so Stop has to say so out loud.
  const postStop = useCallback(
    async (convId: string, messageId: string) => {
      try {
        const res = await fetch(
          `/api/workspace/${workspaceId}/conversations/${convId}/turns/${messageId}/stop`,
          { method: "POST", headers: await authHeaders() }
        );
        if (!res.ok) {
          reportError("Failed to stop workspace turn", {
            page: "workspace",
            workspaceId,
            conversationId: convId,
            messageId,
            http_status: res.status,
          });
        }
      } catch (err) {
        reportError(
          "Failed to stop workspace turn",
          { page: "workspace", workspaceId, conversationId: convId, messageId },
          err
        );
      }
    },
    [authHeaders, workspaceId]
  );

  const stopMessage = useCallback(() => {
    const active = activeTurnRef.current;
    if (!active) {
      // Pressed before the server told us the turn's id (a sub-second window).
      // Remember it and send the stop the moment the id arrives.
      stopRequestedRef.current = true;
      return;
    }
    void postStop(active.convId, active.messageId);
  }, [postStop]);

  // Parse one SSE turn stream and fold its events into `messages`. Shared by the
  // POST that starts a turn and by every reattach, so a reconnected client
  // renders exactly what a first-time one does.
  //
  // Returns whether a terminal event arrived. A stream that ends WITHOUT one no
  // longer means the answer died — the turn runs detached from this connection
  // — so the caller reattaches instead of declaring failure.
  const consumeDocTurn = useCallback(
    async (
      res: Response,
      opts: { convId: string; assistantId: string; tempUserId?: string | null }
    ): Promise<{ terminal: boolean; assistantId: string }> => {
      const { convId, tempUserId } = opts;
      // Reassigned when the server announces the real row id, so every later
      // event targets the persisted message rather than the optimistic one.
      let assistantId = opts.assistantId;
      let sawTerminalEvent = false;

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const apply = (event: string, data: unknown) => {
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
            activeTurnRef.current = { convId, messageId: realId };
            if (stopRequestedRef.current) {
              stopRequestedRef.current = false;
              void postStop(convId, realId);
            }
          }
        } else if (event === "token") {
          const delta = (data as { delta?: string }).delta ?? "";
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m))
          );
        } else if (event === "rollback") {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: "" } : m))
          );
        } else if (event === "status") {
          const phase = (data as { phase?: string }).phase;
          const label =
            phase === "reading"
              ? "Reading the document…"
              : phase === "answering"
                ? "Writing the answer…"
                : phase === "verifying"
                  ? "Verifying citations…"
                  : "Searching your documents…";
          setStatus(label);
        } else if (event === "citations") {
          const cites = (data as DocCitation[]) ?? [];
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, citations: cites } : m))
          );
        } else if (event === "done") {
          sawTerminalEvent = true;
          const d = data as {
            message_id?: string;
            content?: string;
            status?: string;
            error?: string | null;
          };
          // The turn can finish at the HTTP level while the server recorded it
          // as failed or degraded — show that now, not on the next reload. Only
          // banner it if the user is still looking at this conversation; the
          // bubble itself carries the failure either way.
          const doneReason = userFacingError(d.error);
          if (d.status === "error" && doneReason && activeConvRef.current === convId) {
            setChatError(doneReason);
          }
          // A stop is recorded as status "error" with the sentinel reason
          // "cancelled", which userFacingError deliberately maps to null (it is
          // not a failure to report). Keep the sentinel so the bubble renders a
          // stopped turn plainly instead of as an error.
          const cancelled = d.error === "cancelled";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    id: d.message_id || m.id,
                    content: d.content ?? m.content,
                    status: d.status || "success",
                    error: cancelled ? "cancelled" : (doneReason ?? m.error),
                  }
                : tempUserId && m.id === tempUserId
                  ? { ...m, id: `user-${crypto.randomUUID()}` }
                  : m
            )
          );
          // Refresh the conversation list so a freshly auto-titled chat shows up.
          loadDetail();
        } else if (event === "error") {
          sawTerminalEvent = true;
          // Raw provider text — sanitize before display; the server has already
          // persisted the full version on the row.
          const msg =
            userFacingError((data as { message?: string }).message) ??
            "Something went wrong answering from your documents. Please try again.";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, status: "error", error: msg, content: m.content || msg }
                : m
            )
          );
          if (activeConvRef.current === convId) setChatError(msg);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let ev = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataLines.join("\n"));
          } catch {
            parsed = dataLines.join("\n");
          }
          apply(ev, parsed);
        }
      }

      return { terminal: sawTerminalEvent, assistantId };
    },
    [loadDetail, postStop]
  );

  /**
   * Follow a turn that is already running server-side, picking up from whatever
   * text we already have. Used on reload (the conversation load found a
   * `pending` row), and to recover a stream that dropped mid-answer.
   */
  const followDocTurn = useCallback(
    async (convId: string, messageId: string): Promise<boolean> => {
      setSendingConvId(convId);
      activeTurnRef.current = { convId, messageId };

      const currentOffset = () =>
        messagesRef.current.find((m) => m.id === messageId)?.content.length ?? 0;

      try {
        for (let attempt = 0; attempt < ATTACH_MAX_ATTEMPTS; attempt++) {
          try {
            const res = await fetch(
              `/api/workspace/${workspaceId}/conversations/${convId}/turns/${messageId}/stream?offset=${currentOffset()}`,
              { headers: await authHeaders() }
            );
            if (!res.ok || !res.body) return false;
            // Not an SSE stream: the turn had already finished, and the row the
            // client loaded is the whole answer.
            if (!res.headers.get("Content-Type")?.includes("text/event-stream")) {
              return false;
            }
            const { terminal } = await consumeDocTurn(res, {
              convId,
              assistantId: messageId,
            });
            if (terminal) return true;
          } catch (err) {
            reportError(
              "Failed to follow in-progress workspace turn",
              { page: "workspace", workspaceId, conversationId: convId, attempt },
              err
            );
          }
          await new Promise((r) => setTimeout(r, ATTACH_RETRY_MS * (attempt + 1)));
        }

        // Out of attempts. The answer may well still be finishing server-side —
        // say that, rather than claiming it failed.
        if (activeConvRef.current === convId) {
          setChatError(
            "Lost the connection to this answer. It may still be finishing — reload to pick it up."
          );
        }
        return false;
      } finally {
        setSendingConvId((cur) => (cur === convId ? null : cur));
        activeTurnRef.current = null;
        setStatus(null);
        void refreshCredits();
      }
    },
    [authHeaders, consumeDocTurn, refreshCredits, workspaceId]
  );

  // Reattach to an in-progress turn. This is what makes a refresh a non-event:
  // the conversation load returns a `status='pending'` assistant row, and we
  // pick the stream back up from the characters already on it.
  useEffect(() => {
    if (!activeConvId || sendingConvId) return;
    const pending = messages.find((m) => m.role === "assistant" && m.status === "pending");
    if (!pending || pending.id.startsWith("temp-")) return;
    if (followedTurnsRef.current.has(pending.id)) return;
    followedTurnsRef.current.add(pending.id);

    const convId = activeConvId;
    void followDocTurn(convId, pending.id).then((ok) => {
      // Couldn't follow it — the turn finished while we were away, or was
      // reaped. Re-read the conversation so the bubble shows its real outcome.
      // The id stays in followedTurnsRef: if the reload still shows it pending,
      // retrying here would spin.
      if (!ok) void loadMessages(convId);
    });
  }, [activeConvId, sendingConvId, messages, followDocTurn, loadMessages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (readyCount === 0) {
      setChatError("Upload and process at least one document first.");
      return;
    }

    // Ensure there is a conversation to post into.
    let convId = activeConvId;
    if (!convId) {
      convId = await createConversation();
      if (!convId) {
        setChatError("Couldn't start a new chat. Please try again.");
        return;
      }
    }

    setInput("");
    setSendingConvId(convId);
    setStatus(null);
    stopRequestedRef.current = false;
    // Clear the previous turn's failure only here, at the start of a new
    // attempt — never in the `finally`, which runs before the user can read it.
    setChatError(null);

    const tempId = `temp-${crypto.randomUUID()}`;
    const tempUserId = `${tempId}-u`;
    setMessages((prev) => [
      ...prev,
      { id: tempUserId, role: "user", content: text, citations: [], status: "success", error: null },
      { id: tempId, role: "assistant", content: "", citations: [], status: "success", error: null },
    ]);

    let assistantId = tempId;
    try {
      const token = await getToken();
      const res = await fetch(`/api/workspace/${workspaceId}/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text }),
      });

      // Out of credits: open the purchase path rather than a dead-end message.
      if (handlePaymentRequired(res)) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId && m.id !== tempUserId));
        return;
      }

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        const msg = data.message || data.error || "Failed to send message.";
        setChatError(msg);
        setMessages((prev) => prev.filter((m) => m.id !== tempId && m.id !== tempUserId));
        reportError("Workspace chat request failed", {
          page: "workspace",
          workspaceId,
          conversationId: convId,
          http_status: res.status,
          server_error: msg,
        });
        return;
      }

      const outcome = await consumeDocTurn(res, {
        convId,
        assistantId: tempId,
        tempUserId,
      });
      assistantId = outcome.assistantId;
      if (outcome.terminal) return;

      // The stream ended without "done" or "error" — a proxy timeout, a dropped
      // connection, a lost socket. The TURN is still running though; it is no
      // longer tied to this request. Reattach and keep rendering rather than
      // declaring a half-written bubble failed.
      if (assistantId !== tempId) {
        followedTurnsRef.current.add(assistantId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempUserId ? { ...m, id: `user-${crypto.randomUUID()}` } : m
          )
        );
        await followDocTurn(convId, assistantId);
        return;
      }

      // We never even learned the turn's id, so there is nothing to reattach to
      // — the request died before the server got going.
      const msg =
        "The connection to the server was lost before this answer started. Please try again.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId ? { ...m, status: "error", error: msg, content: m.content || msg } : m
        )
      );
      setChatError(msg);
      reportError("Workspace chat stream ended without a terminal event", {
        page: "workspace",
        workspaceId,
        conversationId: convId,
      });
    } catch (err) {
      const msg = "Something went wrong. Please check your connection and try again.";
      // Keep the bubbles and mark the assistant turn failed — the server may
      // already have persisted this turn, so wiping local state would hide it.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, status: "error", error: msg, content: m.content || msg } : m
        )
      );
      setChatError(msg);
      reportError(
        "Workspace chat send failed",
        { page: "workspace", workspaceId, conversationId: convId },
        err
      );
    } finally {
      setSendingConvId((cur) => (cur === convId ? null : cur));
      activeTurnRef.current = null;
      // Each answer spends credits — keep the header meter honest.
      void refreshCredits();
      // Only the transient progress line is cleared here; `chatError` persists
      // until the user starts another turn.
      setStatus(null);
    }
  };


  return (
    <div className="flex-1 flex min-h-0">
      {/* Documents panel */}
      <aside className="w-80 border-r border-ivory-200 flex flex-col bg-ivory-50">
        <div className="px-5 py-4 border-b border-ivory-200">
          <Link href="/workspace" className="text-[12px] text-charcoal-400 hover:text-charcoal-900">
            ← All workspaces
          </Link>
          {editingTitle ? (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                placeholder="Workspace name"
                maxLength={200}
                disabled={savingTitle}
                className="flex-1 min-w-0 rounded-md border border-ivory-200 bg-ivory-50 px-2 py-1 text-[15px] text-charcoal-900 focus:outline-none focus:border-gold-400"
              />
              <button
                onClick={saveTitle}
                disabled={savingTitle}
                className="text-charcoal-500 hover:text-gold-700 disabled:opacity-50"
                title="Save"
              >
                {savingTitle ? (
                  <Spinner size="sm" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => setEditingTitle(false)}
                disabled={savingTitle}
                className="text-charcoal-400 hover:text-charcoal-900 disabled:opacity-50"
                title="Cancel"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-1.5 group">
              <h2 className="font-serif text-lg text-charcoal-900 truncate">
                {title || "Untitled workspace"}
              </h2>
              <button
                onClick={startRename}
                className="text-charcoal-400 hover:text-charcoal-900 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                title="Rename workspace"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-b border-ivory-200">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-navy-950 text-ivory-50 px-4 py-2.5 text-[14px] font-medium hover:bg-navy-800 transition-colors disabled:opacity-50"
          >
            {uploading ? <Spinner size="sm" /> : "Upload documents"}
          </button>
          <p className="text-[11px] text-charcoal-400 mt-2 text-center">PDF, DOCX, JPG, PNG · up to {MAX_FILE_LABEL}</p>
          {uploadError && (
            <p className="text-[12px] text-burgundy-700 mt-2 text-center">{uploadError}</p>
          )}
          {pollTimedOut && (
            <p className="text-[12px] text-charcoal-500 mt-2 text-center leading-relaxed">
              Still processing — this is taking longer than expected. Check back later or refresh.
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {documents.length === 0 ? (
            <p className="text-[13px] text-charcoal-400 text-center py-8 px-4">
              No documents yet. Upload to get started.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {documents.map((d) => (
                <li key={d.id} className="px-3 py-2.5 rounded-lg bg-ivory-100 border border-ivory-200">
                  <div className="flex items-start gap-2">
                    {d.status === "ready" ? (
                      <button
                        onClick={() => openDocument(d.id)}
                        className="flex-1 text-left text-[13px] text-charcoal-900 break-words hover:text-gold-700 transition-colors"
                        title="Open document"
                      >
                        {d.filename}
                      </button>
                    ) : (
                      <span className="flex-1 text-[13px] text-charcoal-900 break-words">{d.filename}</span>
                    )}
                    <StatusBadge status={d.status} />
                  </div>
                  {d.status === "ready" && (
                    <p className="text-[11px] text-charcoal-400 mt-1">
                      {d.chunk_count} chunks{d.ocr_used ? " · OCR" : ""}
                      {d.page_count ? ` · ${d.page_count}p` : ""}
                    </p>
                  )}
                  {d.status === "failed" && d.error && (
                    <p className="text-[11px] text-burgundy-700 mt-1">{d.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Chat panel */}
      <section className="flex-1 flex flex-col min-w-0">
        {/* Conversation switcher + document chips */}
        <div className="border-b border-ivory-200 px-6 py-3 flex items-center justify-between gap-4">
          <div className="relative min-w-0">
            <button
              onClick={() => setConvMenuOpen((o) => !o)}
              className="flex items-center gap-1.5 text-[14px] font-medium text-charcoal-900 hover:text-gold-700 transition-colors max-w-xs"
            >
              <svg className="w-4 h-4 flex-shrink-0 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span className="truncate">{activeConv?.title || (activeConvId ? "Untitled chat" : "New chat")}</span>
              <svg className="w-3.5 h-3.5 flex-shrink-0 text-charcoal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {convMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setConvMenuOpen(false)} />
                <div className="absolute left-0 top-full mt-1 z-20 w-72 max-h-80 overflow-y-auto rounded-lg border border-ivory-200 bg-white shadow-lg py-1">
                  <button
                    onClick={() => {
                      setConvMenuOpen(false);
                      createConversation();
                    }}
                    className="w-full text-left px-4 py-2 text-[13px] text-gold-700 hover:bg-ivory-100 font-medium flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    New chat
                  </button>
                  {conversations.length > 0 && <div className="my-1 border-t border-ivory-200" />}
                  {conversations.map((c) => (
                    <div
                      key={c.id}
                      className={`group flex items-center gap-1 px-2 ${c.id === activeConvId ? "bg-ivory-100" : ""}`}
                    >
                      <button
                        onClick={() => {
                          setActiveConvId(c.id);
                          setPanelCitation(null);
                          setConvMenuOpen(false);
                        }}
                        className="flex-1 text-left px-2 py-2 text-[13px] text-charcoal-900 hover:text-gold-700 truncate"
                      >
                        {c.title || "Untitled chat"}
                      </button>
                      <button
                        onClick={() => deleteConversation(c.id)}
                        className="opacity-0 group-hover:opacity-100 text-charcoal-400 hover:text-burgundy-700 px-1.5 transition-opacity"
                        title="Delete chat"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Documents in this workspace — visible, clickable to open */}
          {documents.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto">
              {documents.map((d) => (
                <button
                  key={d.id}
                  onClick={() => d.status === "ready" && openDocument(d.id)}
                  disabled={d.status !== "ready"}
                  title={d.status === "ready" ? `Open ${d.filename}` : `${d.filename} (${d.status})`}
                  className="flex items-center gap-1.5 flex-shrink-0 rounded-full border border-ivory-200 bg-ivory-100 px-2.5 py-1 text-[11px] text-charcoal-700 hover:border-gold-400 hover:text-gold-700 disabled:opacity-50 disabled:hover:border-ivory-200 disabled:hover:text-charcoal-700 transition-colors max-w-[180px]"
                >
                  <svg className="w-3 h-3 flex-shrink-0 text-gold-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <span className="truncate">{d.filename}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
          <div className="max-w-2xl mx-auto">
            {!loaded ? (
              <div className="flex justify-center py-20">
                <Spinner />
              </div>
            ) : loadError ? (
              <div className="text-center py-16 border border-dashed border-ivory-200 rounded-xl">
                <p className="text-[14px] text-burgundy-700">{loadError}</p>
                <button
                  onClick={() => {
                    setLoaded(false);
                    loadDetail();
                  }}
                  className="mt-3 rounded-lg border border-ivory-200 px-4 py-2 text-[13px] text-charcoal-700 hover:border-gold-400 hover:text-gold-700 transition-colors"
                >
                  Retry
                </button>
              </div>
            ) : messages.length === 0 ? (
              <div className="text-center py-16">
                <h3 className="font-serif text-xl text-charcoal-900">Ask about your documents</h3>
                <p className="text-[14px] text-charcoal-500 mt-2 max-w-md mx-auto leading-relaxed">
                  Answers come only from the documents in this workspace. If something isn&apos;t in
                  them, the assistant will say so rather than guess. Click any [n] citation to see the
                  exact source text.
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <ChatBubble key={m.id} message={m} onCitationClick={setPanelCitation} />
              ))
            )}
          </div>
        </div>

        <div className="border-t border-ivory-200 px-6 py-4">
          <div className="max-w-2xl mx-auto">
            {chatError && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-burgundy-700/30 bg-burgundy-100 px-3 py-2">
                <svg
                  className="w-4 h-4 text-burgundy-700 mt-0.5 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p className="flex-1 text-[12px] text-burgundy-700 leading-relaxed">{chatError}</p>
                <button
                  onClick={() => setChatError(null)}
                  className="text-burgundy-700/60 hover:text-burgundy-700 flex-shrink-0"
                  title="Dismiss"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            {status && <p className="text-[12px] text-charcoal-500 mb-2">{status}</p>}
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                rows={1}
                placeholder={
                  readyCount === 0 ? "Upload a document to begin…" : "Ask a question about your documents…"
                }
                className="flex-1 resize-none rounded-lg border border-ivory-200 bg-ivory-50 px-4 py-3 text-[15px] text-charcoal-900 focus:outline-none focus:border-gold-400 max-h-40"
              />
              <button
                onClick={sendMessage}
                disabled={sending || !input.trim()}
                className="rounded-lg bg-navy-950 text-ivory-50 px-5 py-3 text-[14px] font-medium hover:bg-navy-800 transition-colors disabled:opacity-50"
              >
                {sending ? <Spinner size="sm" /> : "Send"}
              </button>
              {/* Stopping is an explicit instruction to the server now, so it
                  needs a control. Closing the tab used to be the only way to
                  end a doc-chat turn — and it no longer ends one. */}
              {sending && (
                <button
                  type="button"
                  onClick={stopMessage}
                  className="rounded-lg border border-ivory-300 text-charcoal-600 px-4 py-3 text-[14px] font-medium hover:bg-ivory-100 transition-colors"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Source panel */}
      <WorkspaceCitationPanel
        workspaceId={workspaceId}
        citation={panelCitation}
        onClose={() => setPanelCitation(null)}
        onOpenDocument={openDocument}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: DocRow["status"] }) {
  const map: Record<DocRow["status"], string> = {
    pending: "bg-ivory-200 text-charcoal-500",
    processing: "bg-gold-100 text-gold-700",
    ready: "bg-green-100 text-green-700",
    failed: "bg-burgundy-100 text-burgundy-700",
  };
  const label = status === "processing" || status === "pending" ? "Processing" : status;
  return (
    <span className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ${map[status]}`}>
      {label}
    </span>
  );
}

// Turn the model's [n] citation markers into clickable links that open the
// source panel. We only linkify markers that have a matching citation.
function inlineCitations(content: string, validRefs: Set<number>): string {
  return content.replace(/\[(\d+)\]/g, (m, n) =>
    validRefs.has(parseInt(n, 10)) ? `[[${n}]](#doc-cite-${n})` : m
  );
}

const CITE_HREF_RE = /^#doc-cite-(\d+)$/;

function ChatBubble({
  message,
  onCitationClick,
}: {
  message: WsMessage;
  onCitationClick: (c: DocCitation) => void;
}) {
  const isUser = message.role === "user";
  const validRefs = new Set(message.citations.map((c) => c.ref));
  const prepared = isUser ? message.content : inlineCitations(message.content, validRefs);
  const failed = !isUser && message.status === "error";
  const degraded = !isUser && message.status === "degraded";
  // The row stores the raw provider failure for debugging; never render it.
  const failureReason = failed ? userFacingError(message.error) : null;

  const openRef = (href: string): boolean => {
    const match = href.match(CITE_HREF_RE);
    if (!match) return false;
    const ref = parseInt(match[1], 10);
    const cite = message.citations.find((c) => c.ref === ref);
    if (!cite) return false;
    onCitationClick(cite);
    return true;
  };

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-5`}>
      <div
        className={`max-w-[85%] rounded-xl px-5 py-4 ${
          isUser
            ? "bg-navy-950 text-ivory-50"
            : failed
              ? "bg-burgundy-100 border border-burgundy-700/30 text-charcoal-900"
              : "bg-ivory-100 border border-ivory-200 text-charcoal-900"
        }`}
      >
        {isUser ? (
          <p className="text-[15px] whitespace-pre-wrap leading-relaxed">{message.content}</p>
        ) : (
          <>
            <div className="prose prose-sm max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 prose-p:text-charcoal-900 prose-p:leading-relaxed prose-headings:font-serif prose-strong:text-charcoal-900 prose-li:text-charcoal-900 prose-a:no-underline">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children, ...rest }) => {
                    if (href && href.startsWith("#doc-cite-")) {
                      return (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            openRef(href);
                          }}
                          className="inline-flex align-super text-[0.7rem] font-semibold text-gold-700 hover:text-gold-600 bg-gold-100 hover:bg-gold-100/80 rounded px-1.5 py-0.5 mx-0.5 no-underline"
                        >
                          {children}
                        </button>
                      );
                    }
                    return (
                      <a href={href} {...rest}>
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {prepared || "…"}
              </ReactMarkdown>
            </div>
            {/* The failure lives on the turn itself, so it survives scrolling,
                the next message, and a reload (status/error come off the row). */}
            {failed && (
              <div className="mt-3 flex items-start gap-2 border-t border-burgundy-700/20 pt-3">
                <svg
                  className="w-4 h-4 text-burgundy-700 mt-0.5 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p className="text-[12px] text-burgundy-700 leading-relaxed">
                  <span className="font-semibold">This answer failed.</span>
                  {failureReason ? ` ${failureReason}` : " Please try again."}
                </p>
              </div>
            )}
            {degraded && (
              <p className="mt-3 border-t border-ivory-200 pt-3 text-[12px] text-charcoal-500 leading-relaxed">
                This answer came back incomplete. Try rephrasing your question.
              </p>
            )}
            {message.citations.length > 0 && (
              <div className="mt-4 pt-4 border-t border-ivory-200">
                <p className="text-[11px] font-medium text-charcoal-400 uppercase tracking-wider mb-2">
                  Sources
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {message.citations.map((c) => (
                    <button
                      key={c.ref}
                      onClick={() => onCitationClick(c)}
                      className="text-[12px] text-gold-700 hover:text-gold-600 bg-ivory-50 hover:bg-gold-100/60 border border-ivory-200 rounded px-2 py-1 transition-colors text-left max-w-full"
                      title="View source text"
                    >
                      [{c.ref}] {c.document_name}
                      {c.page_no != null ? ` · p.${c.page_no}` : ""}
                      {c.verified === false && <span className="ml-1 text-burgundy-700">⚠</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
