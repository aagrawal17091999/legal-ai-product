"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";
import type { AdminUserDetail, ErrorLog, ErrorSeverity } from "@/types";

/**
 * Staff profile for one user: plan, wallet, and error log, with the four
 * actions support actually needs — grant credits, put them on monthly/yearly,
 * cancel, and read what has been breaking for them.
 *
 * Every mutation is a single POST/DELETE that the server audits (admin_actions),
 * and the page reloads from the server afterwards rather than patching local
 * state — the server does more than the request implies (clamping a claw-back,
 * opening a credit period, unlocking withheld outputs) and guessing at that
 * client-side is how an admin console starts lying about what it did.
 */

const ERROR_PAGE_SIZE = 20;

const SEVERITY_STYLE: Record<ErrorSeverity, string> = {
  critical: "bg-red-100 text-red-800 border-red-300",
  error: "bg-orange-100 text-orange-800 border-orange-300",
  warning: "bg-gold-100 text-charcoal-700 border-gold-400",
};

const QUICK_GRANTS = [100, 500, 1000];

export default function AdminUserProfilePage() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const { getToken } = useAuth();

  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [showResolvedErrors, setShowResolvedErrors] = useState(false);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Action form state
  const [creditAmount, setCreditAmount] = useState("");
  const [reason, setReason] = useState("");
  const [compMonths, setCompMonths] = useState("");

  const authed = useCallback(
    async (url: string, init?: RequestInit) => {
      const token = await getToken();
      return fetch(url, {
        ...init,
        headers: {
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    },
    [getToken]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        userId: String(userId),
        limit: String(ERROR_PAGE_SIZE),
      });
      if (!showResolvedErrors) qs.set("resolved", "false");

      const [profileRes, errorsRes] = await Promise.all([
        authed(`/api/admin/users/${userId}`),
        authed(`/api/admin/errors?${qs}`),
      ]);

      if (profileRes.status === 401 || profileRes.status === 404) {
        setDenied(true);
        return;
      }
      if (!profileRes.ok) {
        setNotice({ kind: "bad", text: "Couldn't load this user." });
        return;
      }
      setData(await profileRes.json());

      if (errorsRes.ok) {
        const e = await errorsRes.json();
        setErrors(e.errors ?? []);
        setErrorTotal(e.total ?? 0);
      }
    } catch {
      setNotice({ kind: "bad", text: "Couldn't reach the server." });
    } finally {
      setLoading(false);
    }
  }, [authed, userId, showResolvedErrors]);

  useEffect(() => {
    load();
  }, [load]);

  /** Run a mutation, surface what the server said it did, then reload. */
  const act = async (
    url: string,
    init: RequestInit,
    describe: (result: Record<string, unknown>) => string
  ) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await authed(url, init);
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({
          kind: "bad",
          text: (result.error as string) || "That didn't work. Try again.",
        });
        return;
      }
      setNotice({ kind: "ok", text: describe(result) });
      await load();
    } catch {
      setNotice({ kind: "bad", text: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  };

  const adjustCredits = (credits: number) =>
    act(
      `/api/admin/users/${userId}/credits`,
      { method: "POST", body: JSON.stringify({ credits, reason }) },
      (r) => {
        const applied = Number(r.applied);
        const verb = applied >= 0 ? "Granted" : "Revoked";
        const clamp = r.clamped
          ? ` (clamped from ${Math.abs(Number(r.requested)).toLocaleString()} — that's all they had)`
          : "";
        return `${verb} ${Math.abs(applied).toLocaleString()} credits${clamp}. New balance: ${Math.round(
          Number(r.remaining)
        ).toLocaleString()}.`;
      }
    );

  const setPlan = (plan: "monthly" | "yearly") => {
    const months = Number(compMonths);
    act(
      `/api/admin/users/${userId}/plan`,
      {
        method: "POST",
        body: JSON.stringify({
          plan,
          ...(Number.isFinite(months) && months > 0 ? { months } : {}),
          reason,
        }),
      },
      (r) =>
        r.mode === "razorpay"
          ? `Switched their Razorpay subscription to ${plan}, effective now.`
          : `Comped the ${plan} plan for ${r.months} month${
              Number(r.months) === 1 ? "" : "s"
            }, until ${new Date(String(r.endDate)).toLocaleDateString()}.`
    );
  };

  const cancel = (immediate: boolean) => {
    const who = data?.user.email ?? "this user";
    const msg = immediate
      ? `End ${who}'s plan immediately? They lose access and their plan credits right now. Purchased credits are kept.`
      : `Cancel ${who}'s plan at the end of the period they've paid for?`;
    if (!window.confirm(msg)) return;
    act(
      `/api/admin/users/${userId}/subscription`,
      { method: "DELETE", body: JSON.stringify({ immediate, reason }) },
      (r) =>
        r.immediate
          ? "Plan ended immediately. Plan credits zeroed; purchased credits kept."
          : `Cancelled at period end${
              r.accessUntil
                ? ` — access until ${new Date(String(r.accessUntil)).toLocaleDateString()}`
                : ""
            }.`
    );
  };

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

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center bg-ivory-50">
        <Spinner />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 overflow-y-auto bg-ivory-50">
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <p className="text-[15px] text-charcoal-600">Couldn&apos;t load this user.</p>
          <Button variant="outline" className="mt-6" onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const { user, balance } = data;
  const onPaidPlan = user.plan !== "free";
  const parsedCredits = Math.round(Number(creditAmount));
  const canAdjust = Number.isFinite(parsedCredits) && parsedCredits !== 0;

  return (
    <div className="flex-1 overflow-y-auto bg-ivory-50">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <Link href="/admin/users" className="text-[13px] text-charcoal-600 hover:text-charcoal-900">
          ← All users
        </Link>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="overline">Staff · user #{user.id}</span>
            <h1 className="mt-3 font-serif text-4xl text-charcoal-900 tracking-tight">
              {user.email}
            </h1>
            <p className="mt-2 text-[14px] text-charcoal-600">
              {user.display_name ? `${user.display_name} · ` : ""}
              joined {new Date(user.created_at).toLocaleDateString()}
              {user.is_staff ? " · staff" : ""}
              {user.unlimited_credits ? " · unlimited credits" : ""}
            </p>
          </div>
          <Button variant="outline" onClick={load} disabled={loading || busy}>
            Refresh
          </Button>
        </div>

        {notice && (
          <p
            className={`mt-6 rounded-lg border px-4 py-3 text-[13px] ${
              notice.kind === "ok"
                ? "border-gold-400 bg-gold-100 text-charcoal-700"
                : "border-red-300 bg-red-50 text-red-700"
            }`}
          >
            {notice.text}
          </p>
        )}

        {/* A single shared note, attached to whichever action is taken next.
            One field rather than one per form: the admin writes why they are
            here, then acts. It lands in admin_actions.reason. */}
        <div className="mt-8">
          <label className="block text-[13px] font-medium text-charcoal-600">
            Note (recorded with the next action)
          </label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. goodwill credit for the failed translation on 12 Aug"
            className="mt-2 w-full rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900 placeholder:text-charcoal-400"
          />
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {/* ------------------------------------------------------- credits */}
          <Card title="Credits">
            <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
              <Row label="Remaining">
                {user.unlimited_credits ? "∞ (unlimited account)" : Math.round(balance.remaining).toLocaleString()}
              </Row>
              <Row label="Plan pool">{Math.round(balance.planCredits).toLocaleString()}</Row>
              <Row label="Top-up / lifetime">
                {Math.round(balance.topupCredits).toLocaleString()}
              </Row>
              <Row label="Period ends">
                {balance.periodEnd ? new Date(balance.periodEnd).toLocaleDateString() : "—"}
              </Row>
            </dl>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <input
                type="number"
                value={creditAmount}
                onChange={(e) => setCreditAmount(e.target.value)}
                placeholder="Credits"
                className="w-32 rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900 placeholder:text-charcoal-400"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={!canAdjust || busy}
                onClick={() => adjustCredits(Math.abs(parsedCredits))}
              >
                Grant
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!canAdjust || busy}
                onClick={() => adjustCredits(-Math.abs(parsedCredits))}
              >
                Revoke
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {QUICK_GRANTS.map((n) => (
                <button
                  key={n}
                  onClick={() => setCreditAmount(String(n))}
                  className="rounded-full border border-ivory-200 px-3 py-1 text-[12px] text-charcoal-600 hover:bg-ivory-100"
                >
                  +{n.toLocaleString()}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-charcoal-400">
              Granted credits go to the persistent top-up pool, so they survive the next
              billing-cycle reset.
            </p>
          </Card>

          {/* ---------------------------------------------------------- plan */}
          <Card title="Plan">
            <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
              <Row label="Plan">
                {user.plan}
                {user.comped_plan ? " (comped)" : ""}
              </Row>
              <Row label="Status">{user.subscription_status}</Row>
              <Row label="Ends">
                {user.subscription_end_date
                  ? new Date(user.subscription_end_date).toLocaleDateString()
                  : "—"}
              </Row>
              <Row label="Subscription">
                <span className="font-mono text-[11px]">
                  {user.razorpay_subscription_id ?? "none (comp only)"}
                </span>
              </Row>
            </dl>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => setPlan("monthly")}
              >
                Set monthly
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => setPlan("yearly")}
              >
                Set annual
              </Button>
              {!user.razorpay_subscription_id && (
                <input
                  type="number"
                  min={1}
                  value={compMonths}
                  onChange={(e) => setCompMonths(e.target.value)}
                  placeholder="months"
                  title="How long to comp the plan for (default: 1 month / 12 for annual)"
                  className="w-24 rounded-lg border border-ivory-200 bg-ivory-100 px-3 py-2 text-[14px] text-charcoal-900 placeholder:text-charcoal-400"
                />
              )}
            </div>

            <p className="mt-3 text-[12px] text-charcoal-400">
              {user.razorpay_subscription_id
                ? "This user has a live Razorpay subscription — the plan is switched in place, with proration, effective now."
                : "No Razorpay subscription: the plan is comped (no charge) for the months given, then expires automatically."}
            </p>

            {onPaidPlan && (
              <div className="mt-5 border-t border-ivory-200 pt-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => cancel(false)}
                  >
                    Cancel at period end
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => cancel(true)}
                  >
                    Cancel immediately
                  </Button>
                </div>
                <p className="mt-3 text-[12px] text-charcoal-400">
                  Cancelling at period end keeps the access and credits they already paid
                  for. Immediate cancellation ends both now; purchased credits are kept
                  either way.
                </p>
              </div>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------------------ errors */}
        <div className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-serif text-2xl text-charcoal-900">Errors.</h2>
              <p className="mt-1 text-[13px] text-charcoal-600">
                {data.errors.total.toLocaleString()} logged ·{" "}
                {data.errors.unresolved.toLocaleString()} unresolved ·{" "}
                {data.errors.critical.toLocaleString()} critical
                {data.errors.lastAt
                  ? ` · last ${new Date(data.errors.lastAt).toLocaleString()}`
                  : ""}
              </p>
            </div>
            <label className="flex items-center gap-2 text-[13px] text-charcoal-600">
              <input
                type="checkbox"
                checked={showResolvedErrors}
                onChange={(e) => setShowResolvedErrors(e.target.checked)}
              />
              Include resolved
            </label>
          </div>

          {errors.length === 0 ? (
            <p className="mt-6 text-[14px] text-charcoal-600">
              Nothing logged for this user{showResolvedErrors ? "" : " that's unresolved"}.
            </p>
          ) : (
            <>
              <div className="mt-4 overflow-x-auto rounded-xl border border-ivory-200">
                <table className="w-full text-[13px]">
                  <thead className="bg-ivory-100 text-left">
                    <tr className="border-b border-ivory-200">
                      <th className="px-3 py-2.5 font-medium text-charcoal-900">When</th>
                      <th className="px-3 py-2.5 font-medium text-charcoal-900">Severity</th>
                      <th className="px-3 py-2.5 font-medium text-charcoal-900">Category</th>
                      <th className="px-3 py-2.5 font-medium text-charcoal-900">Message</th>
                      <th className="px-3 py-2.5 font-medium text-charcoal-900">Endpoint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.map((e) => (
                      <tr
                        key={e.id}
                        className={`border-b border-ivory-200 align-top ${
                          e.resolved ? "opacity-55" : ""
                        }`}
                      >
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-charcoal-600">
                          {new Date(e.created_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[11px] ${
                              SEVERITY_STYLE[e.severity]
                            }`}
                          >
                            {e.severity}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-charcoal-600">
                          {e.category}
                        </td>
                        <td className="px-3 py-2.5 text-charcoal-900">{e.message}</td>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-charcoal-600">
                          {e.method ? `${e.method} ` : ""}
                          {e.endpoint ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {errorTotal > errors.length && (
                <p className="mt-3 text-[13px] text-charcoal-600">
                  Showing the {errors.length} most recent of {errorTotal.toLocaleString()}.{" "}
                  <Link href="/admin/errors" className="text-gold-700 hover:underline">
                    Open the full error log →
                  </Link>
                </p>
              )}
            </>
          )}
        </div>

        {/* ------------------------------------------------------------ ledger */}
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <Card title="Credit ledger">
            {data.transactions.length === 0 ? (
              <p className="text-[13px] text-charcoal-600">No transactions.</p>
            ) : (
              <ul className="space-y-2 text-[13px]">
                {data.transactions.map((t) => (
                  <li key={t.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-charcoal-600">
                      {t.type}
                      <span className="ml-2 text-[11px] text-charcoal-400">
                        {new Date(t.created_at).toLocaleDateString()}
                      </span>
                    </span>
                    <span className="tabular-nums text-charcoal-900">
                      {t.credits > 0 ? "+" : ""}
                      {Math.round(t.credits).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Recent usage">
            {data.usage.length === 0 ? (
              <p className="text-[13px] text-charcoal-600">No metered usage yet.</p>
            ) : (
              <ul className="space-y-2 text-[13px]">
                {data.usage.map((u) => (
                  <li key={u.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-charcoal-600">
                      {u.feature}
                      <span className="ml-2 text-[11px] text-charcoal-400">
                        {new Date(u.created_at).toLocaleDateString()}
                        {u.enforced ? "" : " · shadow"}
                      </span>
                    </span>
                    <span className="tabular-nums text-charcoal-900">
                      −{Math.round(u.credits_charged).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------------ audit trail */}
        <div className="mt-10 mb-16">
          <h2 className="font-serif text-2xl text-charcoal-900">Staff actions.</h2>
          {data.actions.length === 0 ? (
            <p className="mt-3 text-[14px] text-charcoal-600">
              Nothing has been changed on this account from the admin console.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {data.actions.map((a) => (
                <li
                  key={a.id}
                  className="rounded-lg border border-ivory-200 bg-ivory-100/60 px-4 py-3 text-[13px]"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-charcoal-900">
                      {a.action.replace(/_/g, " ")} · {a.actor_email}
                    </span>
                    <span className="text-[11px] text-charcoal-400">
                      {new Date(a.created_at).toLocaleString()}
                    </span>
                  </div>
                  {a.reason && <p className="mt-1 text-charcoal-600">{a.reason}</p>}
                  <pre className="mt-2 overflow-x-auto text-[11px] leading-relaxed text-charcoal-600">
                    {JSON.stringify(a.details)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-ivory-200 bg-ivory-100/40 p-5">
      <h2 className="font-serif text-xl text-charcoal-900">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-charcoal-600">{label}</dt>
      <dd className="text-right text-charcoal-900">{children}</dd>
    </>
  );
}
