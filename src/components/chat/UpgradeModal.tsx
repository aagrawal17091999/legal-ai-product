"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import Modal from "@/components/ui/Modal";
import Button from "@/components/ui/Button";

interface UpgradeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function UpgradeModal({ isOpen, onClose }: UpgradeModalProps) {
  const [subscribing, setSubscribing] = useState(false);
  const { getToken } = useAuth();
  const router = useRouter();

  const handleUpgrade = async (plan: "monthly" | "yearly") => {
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

      if (!res.ok) return;

      const data = await res.json();
      if (data.subscription_id && typeof window !== "undefined") {
        const razorpayKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
        if (razorpayKeyId) {
          const options = {
            key: razorpayKeyId,
            subscription_id: data.subscription_id,
            name: "NyayaSearch",
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
          const rzp = new (window as unknown as { Razorpay: new (opts: typeof options) => { open: () => void } }).Razorpay(options);
          rzp.open();
        }
      }
    } catch {
      // Error handled silently
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Upgrade to Pro">
      <p className="text-[15px] text-charcoal-600 leading-relaxed">
        You&apos;ve used all five free queries for today. Upgrade to Pro for
        unlimited, citation-backed research.
      </p>

      <div className="mt-6 space-y-3">
        <Button
          variant="primary"
          onClick={() => handleUpgrade("monthly")}
          className="w-full"
          disabled={subscribing}
        >
          {subscribing ? "Processing…" : "₹3,000 / month →"}
        </Button>
        <Button
          variant="outline"
          onClick={() => handleUpgrade("yearly")}
          className="w-full"
          disabled={subscribing}
        >
          ₹30,000 / year — save ₹6,000
        </Button>
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
