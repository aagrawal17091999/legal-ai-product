"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useCredits, type CreditsState } from "@/hooks/useCredits";
import TopUpModal from "@/components/chat/TopUpModal";
import { trackClick } from "@/lib/analytics/client";
import { EVENTS } from "@/lib/analytics/events";
import UpgradeModal from "@/components/chat/UpgradeModal";

interface CreditsContextValue {
  credits: CreditsState | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Open the right purchase path for this user (upgrade vs top-up). */
  promptForCredits: () => void;
  /**
   * Handle a fetch Response that may be a 402. Returns true if it WAS a 402 and
   * the purchase prompt has been shown, so the caller can stop and skip its own
   * generic error handling.
   */
  handlePaymentRequired: (res: Response) => boolean;
}

const CreditsContext = createContext<CreditsContextValue | null>(null);

export function useCreditsContext(): CreditsContextValue {
  const ctx = useContext(CreditsContext);
  if (!ctx) throw new Error("useCreditsContext must be used within CreditsProvider");
  return ctx;
}

/**
 * Owns the credit wallet for every authenticated surface: the header meter, the
 * low-balance banner, and both purchase modals.
 *
 * It exists because the purchase path was unreachable. TopUpModal was fully
 * built and imported by nothing, and four endpoints returned 402 that no client
 * handled — so a user who ran out of credits hit a dead end with no way to buy
 * more. Mounting the modals once here means every feature (chat, workspace,
 * translate, OCR) gets the same recovery path from one place.
 */
export default function CreditsProvider({ children }: { children: React.ReactNode }) {
  const { credits, loading, refresh } = useCredits();
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // A free user who runs dry should be sold the plan; a Pro user who has drained
  // this month's pool should be sold a top-up. Showing the wrong one is how you
  // get "I already pay you" support mail.
  const promptForCredits = useCallback(() => {
    const isPro = credits?.plan === "monthly" || credits?.plan === "yearly";
    trackClick(isPro ? EVENTS.TOPUP_PROMPT_SHOWN : EVENTS.UPGRADE_PROMPT_SHOWN, {
      plan: credits?.plan ?? "unknown",
      remaining: credits?.remaining ?? 0,
      exhausted: credits?.exhausted ?? false,
    });
    if (isPro) setTopUpOpen(true);
    else setUpgradeOpen(true);
  }, [credits?.plan, credits?.remaining, credits?.exhausted]);

  const handlePaymentRequired = useCallback(
    (res: Response) => {
      if (res.status !== 402) return false;
      promptForCredits();
      // The balance the server just rejected against is authoritative; pull it
      // so the meter agrees with the modal the user is now looking at.
      void refresh();
      return true;
    },
    [promptForCredits, refresh]
  );

  const value = useMemo(
    () => ({ credits, loading, refresh, promptForCredits, handlePaymentRequired }),
    [credits, loading, refresh, promptForCredits, handlePaymentRequired]
  );

  return (
    <CreditsContext.Provider value={value}>
      {children}
      <TopUpModal
        isOpen={topUpOpen}
        onClose={() => setTopUpOpen(false)}
        tiers={credits?.tiers ?? []}
        gstRate={credits?.gstRate ?? 0.18}
        onSuccess={refresh}
      />
      <UpgradeModal isOpen={upgradeOpen} onClose={() => setUpgradeOpen(false)} />
    </CreditsContext.Provider>
  );
}
