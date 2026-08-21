"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";
import type { AdminUserSummary } from "@/types";

/**
 * Staff user directory — the entry point for every per-account action
 * (credits, plan, cancellation, error log), all of which live on the profile
 * page behind each row.
 *
 * Access is enforced server-side; a non-staff caller gets a 404 from the API
 * and the "not found" panel below. The client check only decides what renders.
 */

const PAGE_SIZE = 25;

const PLAN_STYLE: Record<string, string> = {
  free: "bg-ivory-100 text-charcoal-600 border-ivory-200",
  monthly: "bg-gold-100 text-charcoal-700 border-gold-400",
  yearly: "bg-gold-100 text-charcoal-700 border-gold-400",
};

export default function AdminUsersPage() {
  const { getToken } = useAuth();

  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  // Debounced copy of `q` — typing shouldn't fire a query per keystroke.
  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState("");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Any filter change invalidates the current page offset.
  useEffect(() => {
    setOffset(0);
  }, [query, plan]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const token = await getToken();
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query) qs.set("q", query);
      if (plan) qs.set("plan", plan);

      const res = await fetch(`/api/admin/users?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404 || res.status === 401) {
        setDenied(true);
        return;
      }
      if (!res.ok) {
        setLoadError("Couldn't load users. Try again.");
        return;
      }
      const data = await res.json();
      setUsers(data.users ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setLoadError("Couldn't reach the server.");
    } finally {
      setLoading(false);
    }
  }, [getToken, offset, query, plan]);

  useEffect(() => {
    load();
  }, [load]);

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
              Users.
            </h1>
            <p className="mt-2 text-[14px] text-charcoal-600">
              {total.toLocaleString()} matching
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/admin/errors">
              <Button variant="ghost">Error log →</Button>
            </Link>
            <Button variant="outline" onClick={load} disabled={loading}>
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search email, name, or user id"
            className="min-w-[280px] flex-1 rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900 placeholder:text-charcoal-400"
          />
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900"
          >
            <option value="">All plans</option>
            <option value="free">Free</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
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
        ) : users.length === 0 ? (
          <p className="mt-16 text-center text-[15px] text-charcoal-600">
            No users match that search.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-ivory-200">
            <table className="w-full text-[13px]">
              <thead className="bg-ivory-100 text-left">
                <tr className="border-b border-ivory-200">
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">User</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Plan</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Status</th>
                  <th className="px-3 py-2.5 text-right font-medium text-charcoal-900">
                    Credits
                  </th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Renews / ends</th>
                  <th className="px-3 py-2.5 font-medium text-charcoal-900">Joined</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-ivory-200 align-top hover:bg-ivory-100/60"
                  >
                    <td className="px-3 py-2.5">
                      <div className="text-charcoal-900">{u.email}</div>
                      <div className="text-[11px] text-charcoal-400">
                        #{u.id}
                        {u.display_name ? ` · ${u.display_name}` : ""}
                        {u.is_staff ? " · staff" : ""}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          PLAN_STYLE[u.plan] ?? PLAN_STYLE.free
                        }`}
                      >
                        {u.plan}
                      </span>
                      {u.comped_plan && (
                        <span className="ml-1 text-[11px] text-charcoal-400">comped</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-charcoal-600">
                      {u.subscription_status}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-charcoal-900">
                      {u.unlimited_credits ? "∞" : Math.round(u.remaining).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-charcoal-600">
                      {u.subscription_end_date
                        ? new Date(u.subscription_end_date).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-charcoal-600">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <Link
                        href={`/admin/users/${u.id}`}
                        className="text-gold-700 hover:underline"
                      >
                        Manage →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="mt-6 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || loading}
            >
              ← Previous
            </Button>
            <span className="text-[13px] text-charcoal-600">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <Button
              variant="outline"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
            >
              Next →
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
