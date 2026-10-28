"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import { trackClick } from "@/lib/analytics/client";
import { EVENTS } from "@/lib/analytics/events";
import type { ReferralStatus, ReferralSummary } from "@/lib/referrals/shared";

const STATUS_LABEL: Record<ReferralStatus, string> = {
  signed_up: "Signed up, not paying yet",
  qualified: "Paying ✓",
  disqualified: "Didn't qualify",
};

/**
 * "Refer & earn" on the account page: the user's link, progress toward the next
 * reward, and who they've referred. Anchored at #refer so the sidebar link
 * can land on it.
 */
export default function ReferralCard() {
  const { getToken } = useAuth();
  const [data, setData] = useState<ReferralSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch("/api/referrals", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const summary = (await res.json()) as ReferralSummary;
        if (cancelled) return;
        setData(summary);
        trackClick(EVENTS.REFERRAL_CARD_VIEWED, {
          code: summary.code,
          referrals_signed_up: summary.counts.signedUp,
          referrals_paid: summary.counts.qualified,
          rewards_earned: summary.rewards.earned,
          from_sidebar: window.location.hash === "#refer",
        });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  // The card renders after its fetch, too late for the browser's own jump to
  // #refer — do it once the content is there.
  useEffect(() => {
    if (data && window.location.hash === "#refer") {
      document.getElementById("refer")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [data]);

  if (failed) return null;

  const message = data
    ? `I use Legal Brain for legal research — case law with citations you can check. Sign up with my link: ${data.link}`
    : "";

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      trackClick(EVENTS.REFERRAL_LINK_COPIED, { code: data.code, progress: data.progress });
    } catch {
      /* Clipboard blocked: the link is on screen to select by hand. */
    }
  };

  const shared = (channel: string) => {
    if (data) {
      trackClick(EVENTS.REFERRAL_LINK_SHARED, { code: data.code, channel, progress: data.progress });
    }
  };

  return (
    <div id="refer" className="bg-ivory-100 rounded-xl border border-ivory-200 p-8 scroll-mt-8">
      <h2 className="font-serif text-2xl text-charcoal-900 mb-2">Refer &amp; earn</h2>
      <p className="text-[14px] text-charcoal-600 mb-6">
        Every {data?.perReward ?? 5} colleagues who subscribe to Pro earn you{" "}
        {(data?.creditsPerReward ?? 2000).toLocaleString()} credits — a month of Pro usage. They
        never expire. No limit.
      </p>

      {!data ? (
        <p className="text-[14px] text-charcoal-400">Loading…</p>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <code className="flex-1 truncate rounded-lg border border-ivory-200 bg-ivory-50 px-3 py-2.5 text-[14px] text-charcoal-900">
              {data.link}
            </code>
            <Button size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[13px]">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => shared("whatsapp")}
              className="rounded-full border border-ivory-200 px-3 py-1.5 text-charcoal-700 hover:border-gold-400"
            >
              Share on WhatsApp
            </a>
            <a
              href={`mailto:?subject=${encodeURIComponent("Try Legal Brain")}&body=${encodeURIComponent(message)}`}
              onClick={() => shared("email")}
              className="rounded-full border border-ivory-200 px-3 py-1.5 text-charcoal-700 hover:border-gold-400"
            >
              Share by email
            </a>
            <span className="px-1 py-1.5 text-charcoal-400">
              Code: <span className="font-mono text-charcoal-700">{data.code}</span>
            </span>
          </div>

          <div className="mt-8">
            <div className="flex items-baseline justify-between text-[14px]">
              <span className="text-charcoal-600">Toward your next reward</span>
              <span className="font-medium text-charcoal-900">
                {data.progress} of {data.perReward} paying
              </span>
            </div>
            <div className="mt-2 flex gap-1.5" aria-hidden>
              {Array.from({ length: data.perReward }, (_, i) => (
                <div
                  key={i}
                  className={`h-2 flex-1 rounded-full ${
                    i < data.progress ? "bg-gold-500" : "bg-ivory-200"
                  }`}
                />
              ))}
            </div>
            <p className="mt-3 text-[13px] text-charcoal-600">
              {data.counts.signedUp} signed up · {data.counts.qualified} paying ·{" "}
              {data.rewards.credits.toLocaleString()} credits earned
            </p>
          </div>

          {data.referrals.length > 0 && (
            <ul className="mt-6 divide-y divide-ivory-200 border-t border-ivory-200 text-[13px]">
              {data.referrals.map((r, i) => (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
                  <span className="text-charcoal-900">
                    {r.name} <span className="text-charcoal-400">({r.email})</span>
                  </span>
                  <span className="text-charcoal-600">
                    {STATUS_LABEL[r.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-5 text-[12px] leading-relaxed text-charcoal-400">
            A referral counts as soon as the person you referred makes their first Pro payment.
            Credits are added to your wallet automatically and aren&apos;t exchangeable for cash.
          </p>
        </>
      )}
    </div>
  );
}
