"use client";

import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { loadRazorpay } from "@/lib/loadRazorpay";
import type { TopupTierView } from "@/hooks/useCredits";

interface TopUpModalProps {
  isOpen: boolean;
  onClose: () => void;
  tiers: TopupTierView[];
  /** GST fraction added on top of the listed price (e.g. 0.18). */
  gstRate: number;
  /** Called after a successful top-up so the caller can refresh the balance. */
  onSuccess?: () => void;
}

/**
 * Buy a credit top-up pack. Mirrors UpgradeModal's Razorpay flow but uses a
 * one-time ORDER (credits/order → Checkout → credits/verify) instead of a
 * subscription. The webhook (payment.captured) is the reliable fallback; both
 * grant idempotently.
 */
export default function TopUpModal({
  isOpen,
  onClose,
  tiers,
  gstRate,
  onSuccess,
}: TopUpModalProps) {
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { getToken } = useAuth();

  const handleBuy = async (tier: TopupTierView) => {
    setError(null);
    setBusyTier(tier.id);
    try {
      const token = await getToken();
      const res = await fetch("/api/payments/credits/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tierId: tier.id }),
      });
      if (!res.ok) {
        setError("We couldn't start checkout. Please try again.");
        return;
      }
      const order = await res.json();

      const razorpayKeyId = order.keyId || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      if (!razorpayKeyId || typeof window === "undefined") {
        setError("Payments are unavailable right now. Please contact support.");
        return;
      }

      const options = {
        key: razorpayKeyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: "Legal Brain",
        description: `${tier.credits} credits`,
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const verifyToken = await getToken();
            const vr = await fetch("/api/payments/credits/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${verifyToken}` },
              body: JSON.stringify({
                orderId: response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
              }),
            });
            // The payment.captured webhook grants idempotently as a fallback, so
            // a failed verify here is a display lag, not a lost purchase. Say so
            // rather than leaving the user staring at an unchanged balance.
            if (!vr.ok) {
              setError(
                "Payment received — your credits may take a moment to appear. Refresh if they don't."
              );
              onSuccess?.();
              return;
            }
          } finally {
            onSuccess?.();
          }
          onClose();
        },
      };

      await loadRazorpay();
      const rzp = new (
        window as unknown as { Razorpay: new (opts: typeof options) => { open: () => void } }
      ).Razorpay(options);
      rzp.open();
    } catch {
      setError("Something went wrong starting checkout. Please try again.");
    } finally {
      setBusyTier(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add credits">
      <p className="text-[15px] text-charcoal-600 leading-relaxed">
        Credits power research, document chat, translation, and OCR. Larger packs
        cost less per credit. Top-up credits never expire.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </p>
      )}

      <div className="mt-6 space-y-3">
        {tiers.map((tier) => (
          <Button
            key={tier.id}
            variant="outline"
            onClick={() => handleBuy(tier)}
            className="w-full flex items-center justify-between"
            disabled={busyTier !== null}
          >
            <span>
              {busyTier === tier.id ? "Processing…" : `${tier.credits.toLocaleString()} credits`}
            </span>
            <span className="text-charcoal-600">
              ₹{tier.totalInr.toLocaleString()} · ₹{tier.perCredit}/credit
            </span>
          </Button>
        ))}
      </div>

      <p className="mt-4 text-[12px] text-charcoal-400">
        Prices shown include {Math.round(gstRate * 100)}% GST.
      </p>

      <button
        onClick={onClose}
        className="mt-5 w-full text-center text-[13px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
      >
        Maybe later
      </button>
    </Modal>
  );
}
