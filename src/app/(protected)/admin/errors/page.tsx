"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";
import type { ErrorLog, ErrorCategory, ErrorSeverity } from "@/types";

/**
 * Staff view over error_logs.
 *
 * The API behind this (/api/admin/errors) was already complete — filters,
 * pagination, staff gate, bulk resolve — with nothing calling it, so the only
 * way to read production errors was curl. This is the missing half.
 *
 * Access is enforced server-side: non-staff get a 404 from the API (deliberately
 * not a 403, so the surface isn't even confirmed to exist). The client-side
 * check below only decides what to render.
 */

const CATEGORIES: ErrorCategory[] = [
  "extraction",
  "fetching",
  "search",
  "auth",
  "payment",
  "chat",
  "database",
  "pipeline",
  "frontend",
];
const SEVERITIES: ErrorSeverity[] = ["warning", "error", "critical"];
const PAGE_SIZE = 50;

const SEVERITY_STYLE: Record<ErrorSeverity, string> = {
  critical: "bg-red-100 text-red-800 border-red-300",
  error: "bg-orange-100 text-orange-800 border-orange-300",
  warning: "bg-gold-100 text-charcoal-700 border-gold-400",
};

export default function AdminErrorsPage() {
  const { getToken } = useAuth();

  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [resolved, setResolved] = useState("false");
  // Free-text account identifier: an email address or an internal user id,
  // whichever the support request happened to arrive with. `accountInput` is
  // what the operator is typing; `account` is the debounced value the query
  // actually uses, so typing an address doesn't fire a request per keystroke.
  const [accountInput, setAccountInput] = useState("");
  const [account, setAccount] = useState("");
  // `datetime-local` values ("2026-08-21T14:30"), i.e. local wall-clock with no
  // zone. Converted to a real instant before they reach the API — see below.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [resolving, setResolving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const token = await getToken();
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (category) qs.set("category", category);
      if (severity) qs.set("severity", severity);
      if (resolved) qs.set("resolved", resolved);
      // Digits mean an internal id; anything else is treated as an email.
      const acct = account.trim();
      if (acct) qs.set(/^\d+$/.test(acct) ? "userId" : "email", acct);
      // created_at is TIMESTAMPTZ. Sending the bare "2026-08-21T14:30" string
      // would have Postgres read it in the SERVER's zone (UTC on the box) while
      // the operator typed it in theirs — a silently wrong window, off by the
      // UTC offset. toISOString() pins the instant the operator actually meant.
      if (from) qs.set("from", new Date(from).toISOString());
      if (to) qs.set("to", new Date(to).toISOString());

      const res = await fetch(`/api/admin/errors?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // 404 is what the API returns to non-staff; treat it as "not for you"
      // rather than "missing page", which is what it looks like from outside.
      if (res.status === 404 || res.status === 401) {
        setDenied(true);
        return;
      }
      if (!res.ok) {
        setLoadError("Couldn't load errors. Try again.");
        return;
      }
      const data = await res.json();
      setErrors(data.errors ?? []);
      setTotal(data.total ?? 0);
      setSelected(new Set());
    } catch {
      setLoadError("Couldn't reach the server.");
    } finally {
      setLoading(false);
    }
  }, [getToken, offset, category, severity, resolved, account, from, to]);

  useEffect(() => {
    const t = setTimeout(() => setAccount(accountInput), 350);
    return () => clearTimeout(t);
  }, [accountInput]);

  useEffect(() => {
    load();
  }, [load]);

  // Any filter change invalidates the current page offset.
  useEffect(() => {
    setOffset(0);
  }, [category, severity, resolved, account, from, to]);

  const resolveSelected = async () => {
    if (selected.size === 0) return;
    setResolving(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/errors", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: [...selected] }),
      });
      if (res.ok) await load();
      else setLoadError("Couldn't resolve those. Try again.");
    } catch {
      setLoadError("Couldn't reach the server.");
    } finally {
      setResolving(false);
    }
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOnPageSelected = errors.length > 0 && selected.size === errors.length;
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of errors) c[e.severity] = (c[e.severity] ?? 0) + 1;
    return c;
  }, [errors]);

  if (denied) {
    return (
      <div className="flex-1 overflow-y-auto bg-ivory-50">
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <h1 className="font-serif text-3xl text-charcoal-900">Not found.</h1>
          <p className="mt-4 text-[15px] text-charcoal-600">
            This page is only available to staff accounts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-ivory-50">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="overline">Staff</span>
            <h1 className="mt-3 font-serif text-4xl text-charcoal-900 tracking-tight">
              Error log.
            </h1>
            <p className="mt-2 text-[14px] text-charcoal-600">
              {total.toLocaleString()} matching
              {counts.critical ? ` · ${counts.critical} critical on this page` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/admin/users">
              <Button variant="ghost">Users →</Button>
            </Link>
            <Button variant="outline" onClick={load} disabled={loading}>
              Refresh
            </Button>
            <Button
              variant="primary"
              onClick={resolveSelected}
              disabled={selected.size === 0 || resolving}
            >
              {resolving ? "Resolving…" : `Resolve ${selected.size || ""}`.trim()}
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-8 flex flex-wrap gap-3">
          <select
            value={resolved}
            onChange={(e) => setResolved(e.target.value)}
            className="rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900"
          >
            <option value="false">Unresolved</option>
            <option value="true">Resolved</option>
            <option value="">All</option>
          </select>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900"
          >
            <option value="">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={accountInput}
            onChange={(e) => setAccountInput(e.target.value)}
            placeholder="Account — email or user id"
            aria-label="Filter by account (email or user id)"
            className="min-w-[15rem] rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900 placeholder:text-charcoal-400"
          />
          <label className="flex items-center gap-2 text-[13px] text-charcoal-600">
            From
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900"
            />
          </label>
          <label className="flex items-center gap-2 text-[13px] text-charcoal-600">
            To
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900"
            />
          </label>
          {(accountInput || from || to || category || severity) && (
            <Button
              variant="outline"
              onClick={() => {
                setAccountInput("");
                setFrom("");
                setTo("");
                setCategory("");
                setSeverity("");
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {loadError && (
          <p className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {loadError}
          </p>
        )}

        {loading ? (
          <div className="mt-16 flex justify-center">
            <Spinner />
          </div>
        ) : errors.length === 0 ? (
          <p className="mt-16 text-center text-[15px] text-charcoal-600">
            Nothing here. {resolved === "false" ? "No unresolved errors." : "No matches."}
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-ivory-200">
            <table className="w-full text-[13px]">
              <thead className="bg-ivory-100 text-left">
                <tr className="border-b border-ivory-200">
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allOnPageSelected}
                      onChange={() =>
                        setSelected(
                          allOnPageSelected ? new Set() : new Set(errors.map((e) => e.id))
                        )
                      }
                    />
                  </th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">When</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Severity</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Category</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Message</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Endpoint</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">User</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((e) => (
                  <ErrorRow
                    key={e.id}
                    log={e}
                    selected={selected.has(e.id)}
                    onToggle={() => toggle(e.id)}
                    expanded={expanded === e.id}
                    onExpand={() => setExpanded(expanded === e.id ? null : e.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="mt-6 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || loading}
            >
              ← Newer
            </Button>
            <span className="text-[13px] text-charcoal-600">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <Button
              variant="outline"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
            >
              Older →
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorRow({
  log,
  selected,
  onToggle,
  expanded,
  onExpand,
}: {
  log: ErrorLog;
  selected: boolean;
  onToggle: () => void;
  expanded: boolean;
  onExpand: () => void;
}) {
  const hasDetail = Boolean(log.stack_trace) || Object.keys(log.metadata ?? {}).length > 0;

  return (
    <>
      <tr
        className={`border-b border-ivory-200 align-top ${
          log.resolved ? "opacity-55" : ""
        } hover:bg-ivory-100/60`}
      >
        <td className="px-3 py-2.5">
          <input
            type="checkbox"
            aria-label={`Select error ${log.id}`}
            checked={selected}
            onChange={onToggle}
          />
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-charcoal-600 tabular-nums">
          {new Date(log.created_at).toLocaleString()}
        </td>
        <td className="px-3 py-2.5">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLE[log.severity]}`}
          >
            {log.severity}
          </span>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-charcoal-600">{log.category}</td>
        <td className="px-3 py-2.5 text-charcoal-900">
          <button
            onClick={onExpand}
            className={`text-left ${hasDetail ? "hover:text-gold-700" : "cursor-default"}`}
            disabled={!hasDetail}
          >
            {log.message}
            {hasDetail && (
              <span className="ml-2 text-[11px] text-charcoal-400">
                {expanded ? "hide" : "details"}
              </span>
            )}
          </button>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-charcoal-600">
          {log.method ? `${log.method} ` : ""}
          {log.endpoint ?? "—"}
        </td>
        <td className="px-3 py-2.5 text-charcoal-600 tabular-nums">
          {log.user_id ? (
            // The user id alone was a dead end — this is the jump to the account
            // it happened to, where the plan and wallet explain most of them.
            <Link href={`/admin/users/${log.user_id}`} className="text-gold-700 hover:underline">
              {log.user_id}
            </Link>
          ) : (
            "—"
          )}
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr className="border-b border-ivory-200 bg-ivory-100/70">
          <td colSpan={7} className="px-6 py-4">
            {Object.keys(log.metadata ?? {}).length > 0 && (
              <>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-charcoal-400">
                  Metadata
                </div>
                <pre className="mb-4 overflow-x-auto rounded-lg bg-ivory-50 p-3 text-[11px] leading-relaxed text-charcoal-700">
                  {JSON.stringify(log.metadata, null, 2)}
                </pre>
              </>
            )}
            {log.stack_trace && (
              <>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-charcoal-400">
                  Stack
                </div>
                <pre className="overflow-x-auto rounded-lg bg-ivory-50 p-3 text-[11px] leading-relaxed text-charcoal-700">
                  {log.stack_trace}
                </pre>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
