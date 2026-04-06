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
            handler: () => {
              onClose();
              router.refresh();
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
      <div className="text-center">
        <p className="text-slate-600 mb-6">
          You&apos;ve used all 5 free queries for today. Upgrade to Pro for
          unlimited access.
        </p>

        <div className="space-y-3">
          <Button
            onClick={() => handleUpgrade("monthly")}
            className="w-full"
            disabled={subscribing}
          >
            {subscribing ? "Processing..." : "\u20B93,000/month"}
          </Button>
          <Button
            onClick={() => handleUpgrade("yearly")}
            variant="outline"
            className="w-full"
            disabled={subscribing}
          >
            {"\u20B9"}30,000/year (Save {"\u20B9"}6,000)
          </Button>
        </div>

        <button
          onClick={onClose}
          className="mt-4 text-sm text-slate-500 hover:text-slate-700"
        >
          Maybe later
        </button>
      </div>
    </Modal>
  );
}
