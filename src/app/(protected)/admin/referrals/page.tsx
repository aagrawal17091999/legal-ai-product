"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";

/**
 * Staff queue for referral free months.
 *
 * "Due now" is the exact list the cron acts on. With REFERRAL_REWARDS_AUTO off
 * it is the to-do list, worked through with the buttons here; with it on, a row
 * that stays here means the cron keeps failing on it (see the error log).
 */

interface DueRow {
  reward_id: number;
  user_id: number;
  email: string;
  plan: string;
  milestone: number;
  due_at: string | null;
}

interface RewardRow {
  id: number;
  user_id: number;
  email: string;
  plan: string;
  subscription_status: string;
  milestone: number;
  status: string;
  method: string | null;
  cycle_start: string | null;
  cycle_end: string | null;
  actor: string | null;
  note: string | null;
  earned_at: string;
  applied_at: string | null;
}

interface PendingRow {
  id: number;
  referrer_user_id: number;
  referrer_email: string;
  referee_user_id: number;
  referee_email: string;
  first_paid_at: string;
  qualifies_at: string;
}

interface QueueData {
  auto: boolean;
  method: "pause" | "refund";
  due: { toSchedule: DueRow[]; toComplete: DueRow[] };
  rewards: RewardRow[];
  pending: PendingRow[];
  totals: Record<string, number>;
}

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "—");

export default function AdminReferralsPage() {
  const { getToken } = useAuth();
  const [data, setData] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const authed = useCallback(
    async (url: string, init?: RequestInit) => {
      const token = await getToken();
      return fetch(url, {
        ...init,
        headers: {
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
        },
      });
    },
    [getToken]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authed("/api/admin/referrals");
      if (res.status === 401 || res.status === 404) {
        setDenied(true);
        return;
      }
      if (!res.ok) {
        setNotice({ kind: "bad", text: "Couldn't load the referral queue." });
        return;
      }
      setData(await res.json());
    } catch {
      setNotice({ kind: "bad", text: "Couldn't reach the server." });
    } finally {
      setLoading(false);
    }
  }, [authed]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (rewardId: number, action: "apply" | "complete") => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await authed(`/api/admin/referral-rewards/${rewardId}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      const r = await res.json().catch(() => ({}));
      setNotice(
        res.ok
          ? { kind: "ok", text: `Reward ${rewardId}: ${String(r.status)}.` }
          : { kind: "bad", text: r.error || "That didn't work." }
      );
      await load();
    } catch {
      setNotice({ kind: "bad", text: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  };

  if (denied) {
    return (
      <div className="flex-1 overflow-y-auto bg-ivory-50">
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <h1 className="font-serif text-3xl text-charcoal-900">Not found.</h1>
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
  if (!data) return null;

  const dueCount = data.due.toSchedule.length + data.due.toComplete.length;

  return (
    <div className="flex-1 overflow-y-auto bg-ivory-50">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="overline">Staff</span>
            <h1 className="mt-3 font-serif text-4xl text-charcoal-900 tracking-tight">Referrals.</h1>
            <p className="mt-2 text-[14px] text-charcoal-600">
              {data.totals.referrals} referred · {data.totals.pending} confirming ·{" "}
              {data.totals.qualified} qualified · {data.totals.months_earned} free months earned ·{" "}
              {data.totals.months_applied} given
            </p>
            <p className="mt-1 text-[13px] text-charcoal-600">
              Automation is <strong>{data.auto ? "ON" : "OFF"}</strong> (REFERRAL_REWARDS_AUTO) ·
              method <strong>{data.method}</strong>
              {data.auto ? "" : " — months below are only applied when you press the button."}
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

        <Section title={`Due now (${dueCount})`}>
          {dueCount === 0 ? (
            <Empty>Nothing to do.</Empty>
          ) : (
            <ul className="space-y-2 text-[13px]">
              {data.due.toComplete.map((d) => (
                <DueItem
                  key={`c${d.reward_id}`}
                  row={d}
                  label={`Free month ending ${day(d.due_at)} — resume billing (or chain the next month)`}
                  button="Finish month"
                  busy={busy}
                  onClick={() => act(d.reward_id, "complete")}
                />
              ))}
              {data.due.toSchedule.map((d) => (
                <DueItem
                  key={`s${d.reward_id}`}
                  row={d}
                  label={`Renews ${day(d.due_at)} — skip it with banked month #${d.milestone}`}
                  button={data.method === "refund" && d.plan === "monthly" ? "Book refund" : "Pause"}
                  busy={busy}
                  onClick={() => act(d.reward_id, "apply")}
                />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Free months">
          {data.rewards.length === 0 ? (
            <Empty>None earned yet.</Empty>
          ) : (
            <Table
              head={["User", "Month", "Status", "Skips", "By", "Earned"]}
              rows={data.rewards.map((r) => [
                <Link key="u" href={`/admin/users/${r.user_id}`} className="hover:underline">
                  {r.email}
                </Link>,
                `#${r.milestone} · ${r.plan}`,
                `${r.status}${r.method ? ` (${r.method})` : ""}`,
                r.cycle_start ? `${day(r.cycle_start)} → ${day(r.cycle_end)}` : "—",
                r.actor ?? "—",
                day(r.earned_at),
              ])}
            />
          )}
        </Section>

        <Section title={`Confirming (${data.pending.length})`}>
          {data.pending.length === 0 ? (
            <Empty>No referrals inside their 7-day window.</Empty>
          ) : (
            <Table
              head={["Referrer", "Referred", "First paid", "Counts from"]}
              rows={data.pending.map((p) => [
                <Link key="a" href={`/admin/users/${p.referrer_user_id}`} className="hover:underline">
                  {p.referrer_email}
                </Link>,
                <Link key="b" href={`/admin/users/${p.referee_user_id}`} className="hover:underline">
                  {p.referee_email}
                </Link>,
                day(p.first_paid_at),
                day(p.qualifies_at),
              ])}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

function DueItem({
  row,
  label,
  button,
  busy,
  onClick,
}: {
  row: DueRow;
  label: string;
  button: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ivory-200 bg-ivory-100/60 px-4 py-3">
      <span className="text-charcoal-900">
        <Link href={`/admin/users/${row.user_id}`} className="hover:underline">
          {row.email}
        </Link>{" "}
        <span className="text-charcoal-600">({row.plan}) · {label}</span>
      </span>
      <Button size="sm" variant="primary" disabled={busy} onClick={onClick}>
        {button}
      </Button>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl text-charcoal-900">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[14px] text-charcoal-600">{children}</p>;
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-ivory-200">
      <table className="w-full text-[13px]">
        <thead className="bg-ivory-100 text-left">
          <tr className="border-b border-ivory-200">
            {head.map((h) => (
              <th key={h} className="px-3 py-2.5 font-medium text-charcoal-900">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-b border-ivory-200">
              {cells.map((c, j) => (
                <td key={j} className="px-3 py-2.5 text-charcoal-700">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
