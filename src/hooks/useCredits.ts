"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "./useAuth";

export interface TopupTierView {
  id: string;
  credits: number;
  /** Listed, ex-GST. */
  priceInr: number;
  /** What the card is actually charged (priceInr + GST). */
  totalInr: number;
  perCredit: number;
}

export interface CreditsState {
  plan: string;
  unlimited: boolean;
  remaining: number;
  planCredits: number;
  topupCredits: number;
  periodEnd: string | null;
  /** Running low — warn, but work still goes through. */
  lowBalance: boolean;
  /** Out — new work is blocked with a 402. */
  exhausted: boolean;
  gstRate: number;
  /** Subscription plans currently on sale. */
  plans: { monthly: boolean; yearly: boolean };
  tiers: TopupTierView[];
}

/**
 * Reads the credit wallet for the signed-in user. Powers the header meter, the
 * low-balance banner, and the top-up modal. Call `refresh()` after a question
 * completes or a top-up succeeds to update the displayed balance.
 */
export function useCredits() {
  const { getToken } = useAuth();
  const [credits, setCredits] = useState<CreditsState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch("/api/user/credits", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setCredits((await res.json()) as CreditsState);
    } catch {
      // Non-fatal — the meter just won't update this tick.
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { credits, loading, refresh };
}
