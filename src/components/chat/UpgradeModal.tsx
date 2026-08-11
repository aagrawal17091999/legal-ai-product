"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";
import { loadRazorpay } from "@/lib/loadRazorpay";
import { useCreditsContext } from "@/components/credits/CreditsProvider";
import { trackClick } from "@/lib/analytics/client";
import { EVENTS } from "@/lib/analytics/events";

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function UpgradeModal({ isOpen, onClose }: UpgradeModalProps) {
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Never offer a plan the server can't bill. Unsetting its RAZORPAY_PLAN_* id
  // is the kill switch — used when a plan is misconfigured at the provider and
  // has to be replaced (period/interval are immutable once a plan exists).
  const { credits } = useCreditsContext();
  const canMonthly = credits?.plans?.monthly !== false;
  const canYearly = credits?.plans?.yearly !== false;
  const { getToken } = useAuth();
  const router = useRouter();

  const handleUpgrade = async (plan: "monthly" | "yearly") => {
    trackClick(EVENTS.PLAN_CLICKED, { plan });
    setError(null);
    setSubscribing(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/payments/create-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan }),
      });

      if (!res.ok) {
        setError("We couldn't start checkout. Please try again.");
        return;
      }

      const data = await res.json();
      if (data.subscription_id && typeof window !== "undefined") {
        const razorpayKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
        if (razorpayKeyId) {
          const options = {
            key: razorpayKeyId,
            subscription_id: data.subscription_id,
            name: "Legal Brain",
            description: `Pro ${plan === "monthly" ? "Monthly" : "Yearly"} Plan`,
            handler: async (response: {
              razorpay_payment_id: string;
              razorpay_subscription_id: string;
              razorpay_signature: string;
            }) => {
              try {
                const verifyToken = await getToken();
                await fetch("/api/payments/verify-subscription", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${verifyToken}`,
                  },
                  body: JSON.stringify(response),
                });
              } finally {
                onClose();
                router.refresh();
              }
            },
          };
          await loadRazorpay();
          const rzp = new (window as unknown as { Razorpay: new (opts: typeof options) => { open: () => void } }).Razorpay(options);
          rzp.open();
        }
      }
    } catch {
      setError("Something went wrong starting checkout. Please try again.");
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Upgrade to Pro">
      <p className="text-[15px] text-charcoal-600 leading-relaxed">
        You&apos;ve used your free credits. Upgrade to Pro for 1,000 credits
        every month of citation-backed research, plus full access to document
        workspaces, translation, and OCR.
      </p>

      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </p>
      )}

      <div className="mt-6 space-y-3">
        {canMonthly && (
          <Button
            variant="primary"
            onClick={() => handleUpgrade("monthly")}
            className="w-full"
            disabled={subscribing}
          >
            {subscribing ? "Processing…" : "₹2,000 / month →"}
          </Button>
        )}
        {canYearly && (
          <Button
            variant={canMonthly ? "outline" : "primary"}
            onClick={() => handleUpgrade("yearly")}
            className="w-full"
            disabled={subscribing}
          >
            ₹20,000 / year — save ₹4,000
          </Button>
        )}
      </div>

      <p className="mt-4 text-[12px] text-charcoal-400">
        Plus 18% GST. Both plans include 1,000 credits per month.
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
