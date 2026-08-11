"use client";

import { useCreditsContext } from "./CreditsProvider";
import { trackClick } from "@/lib/analytics/client";
import { EVENTS } from "@/lib/analytics/events";

/**
 * Credit balance in the app header. Clicking it opens the purchase path.
 *
 * The balance was previously invisible everywhere in the product, so the first
 * signal a user got that credits existed at all was being blocked by one. The
 * meter turns amber while there is still room to act, and red once work is
 * actually blocked.
 */
export default function CreditMeter() {
  const { credits, loading, promptForCredits } = useCreditsContext();

  if (loading || !credits) return null;

  if (credits.unlimited) {
    return (
      <span className="text-[13px] text-charcoal-400 tabular-nums" title="Unlimited account">
        Unlimited
      </span>
    );
  }

  const tone = credits.exhausted
    ? "border-red-300 bg-red-50 text-red-700 hover:border-red-400"
    : credits.lowBalance
      ? "border-gold-400 bg-gold-100/60 text-charcoal-900 hover:border-gold-500"
      : "border-ivory-200 bg-ivory-100 text-charcoal-600 hover:border-charcoal-300";

  const label = credits.exhausted
    ? "Out of credits"
    : `${Math.max(0, credits.remaining).toLocaleString()} credits`;

  return (
    <button
      onClick={() => {
        trackClick(EVENTS.CREDIT_METER_CLICKED, {
          remaining: credits.remaining,
          exhausted: credits.exhausted,
        });
        promptForCredits();
      }}
      className={`rounded-full border px-3 py-1 text-[13px] tabular-nums transition-colors ${tone}`}
      title={
        credits.exhausted
          ? "You're out of credits — click to add more"
          : credits.lowBalance
            ? "Running low — click to add credits"
            : "Credit balance — click to add more"
      }
    >
      {label}
    </button>
  );
}
