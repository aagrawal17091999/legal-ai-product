"use client";

import { useEffect } from "react";
import { useCreditsContext } from "./CreditsProvider";
import { trackClick } from "@/lib/analytics/client";
import { EVENTS } from "@/lib/analytics/events";

/**
 * Warns before the wall, and explains it after.
 *
 * Without this the only signal a user ever received about credits was the 402
 * that had already stopped their work mid-task. Shown app-wide because credits
 * are spent by chat, document workspaces, translation, and OCR alike.
 */
export default function LowBalanceBanner() {
  const { credits, promptForCredits } = useCreditsContext();
  const state =
    !credits || credits.unlimited
      ? null
      : credits.exhausted
        ? "exhausted"
        : credits.lowBalance
          ? "low"
          : null;

  // Once per state change, not per render: the banner re-renders on every
  // credit refresh.
  useEffect(() => {
    if (!state || !credits) return;
    trackClick(EVENTS.LOW_BALANCE_BANNER_SHOWN, {
      state,
      credits_remaining: credits.remaining,
      plan: credits.plan,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!credits || credits.unlimited) return null;
  if (!credits.lowBalance && !credits.exhausted) return null;

  const isPro = credits.plan === "monthly" || credits.plan === "yearly";
  const action = isPro ? "Add credits" : "Upgrade to Pro";

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-3 border-b px-5 py-2.5 text-[13px] ${
        credits.exhausted
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-gold-400 bg-gold-100/60 text-charcoal-700"
      }`}
    >
      <span>
        {credits.exhausted ? (
          <>
            You&apos;re out of credits. New research, document chats,
            translations, and OCR are paused until you top up.
          </>
        ) : (
          <>
            You have {Math.max(0, credits.remaining).toLocaleString()} credits
            left. Work keeps running until they reach zero.
          </>
        )}
      </span>
      <button
        onClick={promptForCredits}
        className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
      >
        {action}
      </button>
    </div>
  );
}
