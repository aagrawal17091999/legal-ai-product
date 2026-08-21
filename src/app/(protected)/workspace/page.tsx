"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { reportError } from "@/lib/report-error";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";

interface WorkspaceSummary {
  id: string;
  title: string | null;
  document_count: number;
  ready_count: number;
  updated_at: string;
}

export default function WorkspaceListPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Failures from an action (create/rename/delete) rather than the initial load.
  // Kept separate from `error`, which replaces the entire list with a retry
  // panel — blanking the list because a delete failed would be wrong.
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const authHeaders = useCallback(async () => {
    const token = await getToken();
    return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  }, [getToken]);

  const load = useCallback(async () => {
    setError(null);
    // Time-box the WHOLE load — including the token refresh, which can stall
    // independently of the fetch — so a hung backend or auth never leaves the
    // page on an indefinite spinner. Always resolves to data or a retry prompt.
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
        const res = await fetch("/api/workspace", { headers, signal: controller.signal });
        if (res.ok) setWorkspaces(await res.json());
        else setError("Couldn't load your workspaces. Please try again.");
      })();
      await Promise.race([run, deadline]);
    } catch {
      setError("Couldn't reach the server. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    load();
  }, [load]);

  const startRename = (ws: WorkspaceSummary) => {
    setDraft(ws.title ?? "");
    setEditingId(ws.id);
  };

  const saveRename = async (id: string) => {
    const next = draft.trim();
    setSavingId(id);
    try {
      const res = await fetch(`/api/workspace/${id}`, {
        method: "PATCH",
        headers: await authHeaders(),
        body: JSON.stringify({ title: next }),
      });
      if (res.ok) {
        const data = await res.json();
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === id ? { ...w, title: data.title ?? null } : w))
        );
        setEditingId(null);
        setActionError(null);
      } else {
        // Previously silent: the field just stayed in edit mode as though the
        // save had never been clicked.
        setActionError("Couldn't rename this workspace. Please try again.");
        reportError("Failed to rename workspace", {
          page: "workspace_list",
          workspaceId: id,
          http_status: res.status,
        });
      }
    } catch (err) {
      setActionError("Couldn't reach the server. Check your connection and try again.");
      reportError("Failed to rename workspace", { page: "workspace_list", workspaceId: id }, err);
    } finally {
      setSavingId(null);
    }
  };

  const deleteWorkspace = async (ws: WorkspaceSummary) => {
    const label = ws.title || "Untitled workspace";
    if (
      !window.confirm(
        `Delete "${label}"? Its documents and chats will be permanently removed. This can't be undone.`
      )
    )
      return;
    setDeletingId(ws.id);
    try {
      const res = await fetch(`/api/workspace/${ws.id}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      if (res.ok) {
        setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
        setActionError(null);
      } else {
        // Previously silent: the row stayed put and the user had no way to tell
        // whether the delete had been rejected or simply not registered.
        setActionError(`Couldn't delete "${label}". Please try again.`);
        reportError("Failed to delete workspace", {
          page: "workspace_list",
          workspaceId: ws.id,
          http_status: res.status,
        });
      }
    } catch (err) {
      setActionError("Couldn't reach the server. Check your connection and try again.");
      reportError("Failed to delete workspace", { page: "workspace_list", workspaceId: ws.id }, err);
    } finally {
      setDeletingId(null);
    }
  };

  const createWorkspace = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/workspace", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const ws = await res.json();
        setActionError(null);
        router.push(`/workspace/${ws.id}`);
        return;
      }
      // Previously silent: "New workspace" spun briefly and then did nothing at
      // all, with no indication that anything had gone wrong.
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      setActionError(
        typeof data.error === "string"
          ? data.error
          : "Couldn't create a workspace. Please try again."
      );
      reportError("Failed to create workspace", {
        page: "workspace_list",
        http_status: res.status,
      });
    } catch (err) {
      setActionError("Couldn't reach the server. Check your connection and try again.");
      reportError("Failed to create workspace", { page: "workspace_list" }, err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="font-serif text-2xl text-charcoal-900">Document Workspaces</h1>
            <p className="text-[14px] text-charcoal-500 mt-1.5 max-w-xl leading-relaxed">
              Upload documents and chat with an assistant that answers{" "}
              <span className="font-medium text-charcoal-700">only from those documents</span> —
              with citations back to the source so you can verify every answer.
            </p>
          </div>
          <Button onClick={createWorkspace} disabled={creating}>
            {creating ? <Spinner /> : "New workspace"}
          </Button>
        </div>

        {actionError && (
          <div className="mb-5 flex items-start gap-2 rounded-lg border border-burgundy-700/30 bg-burgundy-100 px-4 py-3">
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
            <p className="flex-1 text-[13px] text-burgundy-700 leading-relaxed">{actionError}</p>
            <button
              onClick={() => setActionError(null)}
              className="text-burgundy-700/60 hover:text-burgundy-700 flex-shrink-0"
              title="Dismiss"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        ) : error ? (
          <div className="text-center py-16 border border-dashed border-ivory-200 rounded-xl">
            <p className="text-[14px] text-burgundy-700">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                setLoading(true);
                load();
              }}
            >
              Retry
            </Button>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-ivory-200 rounded-xl">
            <p className="text-[15px] text-charcoal-500">No workspaces yet.</p>
            <p className="text-[13px] text-charcoal-400 mt-1">
              Create one to upload documents and start asking questions.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {workspaces.map((ws) => {
              const isEditing = editingId === ws.id;
              const open = () => router.push(`/workspace/${ws.id}`);
              return (
                <li key={ws.id}>
                  <div
                    role={isEditing ? undefined : "button"}
                    tabIndex={isEditing ? undefined : 0}
                    onClick={isEditing ? undefined : open}
                    onKeyDown={
                      isEditing
                        ? undefined
                        : (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              open();
                            }
                          }
                    }
                    className={`group bg-ivory-100 border border-ivory-200 rounded-xl px-5 py-4 transition-colors ${
                      isEditing ? "" : "hover:bg-ivory-200 cursor-pointer"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      {isEditing ? (
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <input
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveRename(ws.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            placeholder="Workspace name"
                            maxLength={200}
                            disabled={savingId === ws.id}
                            className="flex-1 min-w-0 rounded-md border border-ivory-200 bg-ivory-50 px-2 py-1 text-[15px] text-charcoal-900 focus:outline-none focus:border-gold-400"
                          />
                          <button
                            onClick={() => saveRename(ws.id)}
                            disabled={savingId === ws.id}
                            className="text-charcoal-500 hover:text-gold-700 disabled:opacity-50 flex-shrink-0"
                            title="Save"
                          >
                            {savingId === ws.id ? (
                              <Spinner size="sm" />
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            disabled={savingId === ws.id}
                            className="text-charcoal-400 hover:text-charcoal-900 disabled:opacity-50 flex-shrink-0"
                            title="Cancel"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[15px] font-medium text-charcoal-900 truncate">
                            {ws.title || "Untitled workspace"}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(ws);
                            }}
                            className="text-charcoal-400 hover:text-charcoal-900 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                            title="Rename workspace"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                        </div>
                      )}
                      {!isEditing && (
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[12px] text-charcoal-400">
                            {new Date(ws.updated_at).toLocaleDateString()}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteWorkspace(ws);
                            }}
                            disabled={deletingId === ws.id}
                            className="text-charcoal-400 hover:text-burgundy-700 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                            title="Delete workspace"
                          >
                            {deletingId === ws.id ? (
                              <Spinner size="sm" />
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                    <p className="text-[13px] text-charcoal-500 mt-1">
                      {ws.document_count} document{ws.document_count === 1 ? "" : "s"}
                      {ws.document_count > 0 && ws.ready_count < ws.document_count && (
                        <span className="text-gold-700"> · {ws.document_count - ws.ready_count} processing</span>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
