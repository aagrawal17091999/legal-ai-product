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
  /** Called after a successful top-up so the caller can refresh the balance. */
  onSuccess?: () => void;
}

/**
 * Buy a credit top-up pack. Mirrors UpgradeModal's Razorpay flow but uses a
 * one-time ORDER (credits/order → Checkout → credits/verify) instead of a
 * subscription. The webhook (payment.captured) is the reliable fallback; both
 * grant idempotently.
 */
export default function TopUpModal({ isOpen, onClose, tiers, onSuccess }: TopUpModalProps) {
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const { getToken } = useAuth();

  const handleBuy = async (tier: TopupTierView) => {
    setBusyTier(tier.id);
    try {
      const token = await getToken();
      const res = await fetch("/api/payments/credits/order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tierId: tier.id }),
      });
      if (!res.ok) return;
      const order = await res.json();

      const razorpayKeyId = order.keyId || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      if (!razorpayKeyId || typeof window === "undefined") return;

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
            await fetch("/api/payments/credits/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${verifyToken}` },
              body: JSON.stringify({
                orderId: response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
              }),
            });
          } finally {
            onSuccess?.();
            onClose();
          }
        },
      };

      await loadRazorpay();
      const rzp = new (
        window as unknown as { Razorpay: new (opts: typeof options) => { open: () => void } }
      ).Razorpay(options);
      rzp.open();
    } catch {
      // Error handled silently — the modal stays open for a retry.
    } finally {
      setBusyTier(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add credits">
      <p className="text-[15px] text-charcoal-600 leading-relaxed">
        Credits power research, document chat, translation, and OCR. Larger packs
        cost less per credit. Credits never expire.
      </p>

      <div className="mt-6 space-y-3">
        {tiers.map((tier) => (
          <Button
            key={tier.id}
            variant="outline"
            onClick={() => handleBuy(tier)}
            className="w-full flex items-center justify-between"
            disabled={busyTier !== null}
          >
            <span>{busyTier === tier.id ? "Processing…" : `${tier.credits.toLocaleString()} credits`}</span>
            <span className="text-charcoal-600">
              ₹{tier.priceInr.toLocaleString()} · ₹{tier.perCredit}/credit
            </span>
          </Button>
        ))}
      </div>

      <button
        onClick={onClose}
        className="mt-5 w-full text-center text-[13px] text-charcoal-600 hover:text-charcoal-900 transition-colors"
      >
        Maybe later
      </button>
    </Modal>
  );
}
