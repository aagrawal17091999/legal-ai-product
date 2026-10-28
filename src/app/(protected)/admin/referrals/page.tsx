"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import Spinner from "@/components/ui/Spinner";

/**
 * Staff overview of the referral program: totals, referrals still inside their
 * 7-day window, and the credit rewards paid. Rewards are paid automatically by
 * the hourly cron; anything to correct (a disqualification, a claw-back) is done
 * from the user's own admin page.
 */

interface RewardRow {
  id: number;
  user_id: number;
  email: string;
  milestone: number;
  status: string;
  credits: number | null;
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

interface Overview {
  enabled: boolean;
  rewards: RewardRow[];
  pending: PendingRow[];
  totals: Record<string, number>;
}

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "—");

export default function AdminReferralsPage() {
  const { getToken } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/referrals", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 404) {
        setDenied(true);
        return;
      }
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setData(await res.json());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    load();
  }, [load]);

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
  if (!data) {
    return (
      <div className="flex-1 overflow-y-auto bg-ivory-50">
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <p className="text-[15px] text-charcoal-600">
            {failed ? "Couldn't load the referral overview." : ""}
          </p>
          <Button variant="outline" className="mt-6" onClick={load}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const t = data.totals;
  return (
    <div className="flex-1 overflow-y-auto bg-ivory-50">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="overline">Staff</span>
            <h1 className="mt-3 font-serif text-4xl text-charcoal-900 tracking-tight">Referrals.</h1>
            <p className="mt-2 text-[14px] text-charcoal-600">
              {t.referrals} referred · {t.pending} confirming · {t.qualified} qualified ·{" "}
              {t.disqualified} disqualified · {t.rewards} rewards ·{" "}
              {t.credits.toLocaleString()} credits paid
            </p>
            <p className="mt-1 text-[13px] text-charcoal-600">
              Program is <strong>{data.enabled ? "ON" : "OFF"}</strong> for users
              (NEXT_PUBLIC_REFERRALS_ENABLED).
            </p>
          </div>
          <Button variant="outline" onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>

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

        <Section title="Rewards paid">
          {data.rewards.length === 0 ? (
            <Empty>None yet.</Empty>
          ) : (
            <Table
              head={["User", "Reward", "Credits", "Status", "Paid"]}
              rows={data.rewards.map((r) => [
                <Link key="u" href={`/admin/users/${r.user_id}`} className="hover:underline">
                  {r.email}
                </Link>,
                `#${r.milestone}`,
                (r.credits ?? 0).toLocaleString(),
                r.status,
                day(r.applied_at),
              ])}
            />
          )}
        </Section>
      </div>
    </div>
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
