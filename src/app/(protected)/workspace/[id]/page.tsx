"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { use as usePromise } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuth } from "@/hooks/useAuth";
import Spinner from "@/components/ui/Spinner";
import WorkspaceCitationPanel, { type DocCitation } from "@/components/workspace/CitationPanel";

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

interface WsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: DocCitation[];
  status: string;
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
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
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

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return { Authorization: `Bearer ${token}` };
  }, [getToken]);

  const loadMessages = useCallback(
    async (convId: string) => {
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
          }))
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
    const res = await fetch(`/api/workspace/${workspaceId}/documents`, {
      headers: await authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      setDocuments(data.documents ?? []);
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

  // Poll while any document is still processing — but give up after ~10 minutes
  // so a doc stuck pending/processing on the backend doesn't poll indefinitely.
  const POLL_TIMEOUT_MS = 10 * 60 * 1000;
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
      }
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
        } else if (w) {
          w.close();
        }
      } catch {
        if (w) w.close();
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
    if (!res.ok) return null;
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
      if (!res.ok) return;
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

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (readyCount === 0) {
      setStatus("Upload and process at least one document first.");
      return;
    }

    // Ensure there is a conversation to post into.
    let convId = activeConvId;
    if (!convId) {
      convId = await createConversation();
      if (!convId) {
        setStatus("Couldn't start a new chat. Please try again.");
        return;
      }
    }

    setInput("");
    setSending(true);
    setStatus(null);

    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: `${tempId}-u`, role: "user", content: text, citations: [], status: "success" },
      { id: tempId, role: "assistant", content: "", citations: [], status: "success" },
    ]);

    try {
      const token = await getToken();
      const res = await fetch(`/api/workspace/${workspaceId}/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setStatus(data.message || data.error || "Failed to send message.");
        setMessages((prev) => prev.filter((m) => m.id !== tempId && m.id !== `${tempId}-u`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const apply = (event: string, data: unknown) => {
        if (event === "token") {
          const delta = (data as { delta?: string }).delta ?? "";
          setMessages((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, content: m.content + delta } : m))
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
          setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, citations: cites } : m)));
        } else if (event === "done") {
          const d = data as { message_id?: string; content?: string; status?: string };
          setMessages((prev) =>
            prev.map((m) =>
              m.id === tempId
                ? { ...m, id: d.message_id || m.id, content: d.content ?? m.content, status: d.status || m.status }
                : m
            )
          );
          // Refresh the conversation list so a freshly auto-titled chat shows up.
          loadDetail();
        } else if (event === "error") {
          const msg = (data as { message?: string }).message || "Error";
          setMessages((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, status: "error", content: m.content || msg } : m))
          );
          setStatus(msg);
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
    } catch {
      setStatus("Something went wrong. Please try again.");
    } finally {
      setSending(false);
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
          <p className="text-[11px] text-charcoal-400 mt-2 text-center">PDF, DOCX, JPG, PNG · up to 25 MB</p>
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
          isUser ? "bg-navy-950 text-ivory-50" : "bg-ivory-100 border border-ivory-200 text-charcoal-900"
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
