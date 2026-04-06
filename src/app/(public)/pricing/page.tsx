"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";

const plans = {
  monthly: { price: "3,000", period: "/month", planKey: "monthly" as const },
  yearly: {
    price: "30,000",
    period: "/year",
    savings: "Save \u20B96,000",
    planKey: "yearly" as const,
  },
};

const freeFeatures = [
  "5 queries per day",
  "All courts & filters",
  "Full judgment access",
  "Chat history",
];

const proFeatures = [
  "Unlimited queries",
  "All courts & filters",
  "Full judgment access",
  "Chat history",
  "Priority support",
];

export default function PricingPage() {
  const [billing, setBilling] = useState<"monthly" | "yearly">("monthly");
  const [subscribing, setSubscribing] = useState(false);
  const { user, loading, getToken } = useAuth();
  const router = useRouter();
  const plan = plans[billing];

  const isLoggedIn = !loading && !!user;

  const handleFreeClick = () => {
    router.push(isLoggedIn ? "/chat" : "/signup");
  };

  const handleSubscribe = async () => {
    if (!isLoggedIn) {
      router.push("/signup");
      return;
    }

    setSubscribing(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/payments/create-subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: billing }),
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
            description: `Pro ${billing === "monthly" ? "Monthly" : "Yearly"} Plan`,
            handler: () => {
              router.push("/chat");
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
    <div className="py-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-slate-900">
            Simple, transparent pricing
          </h1>
          <p className="mt-4 text-lg text-slate-600">
            Start free. Upgrade when you need unlimited access.
          </p>

          {/* Billing toggle */}
          <div className="mt-8 inline-flex items-center gap-3 bg-slate-100 rounded-full p-1">
            <button
              onClick={() => setBilling("monthly")}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                billing === "monthly"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling("yearly")}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                billing === "yearly"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600"
              }`}
            >
              Yearly
              {billing === "yearly" && (
                <span className="ml-2 text-xs text-green-600 font-semibold">
                  {plans.yearly.savings}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
          {/* Free Plan */}
          <div className="rounded-xl border border-slate-200 p-8">
            <h2 className="text-lg font-semibold text-slate-900">Free</h2>
            <p className="mt-1 text-sm text-slate-500">
              Perfect for getting started
            </p>
            <div className="mt-6">
              <span className="text-4xl font-bold text-slate-900">
                {"\u20B9"}0
              </span>
              <span className="text-slate-500">/month</span>
            </div>
            <Button
              variant="outline"
              className="w-full mt-6"
              onClick={handleFreeClick}
            >
              {isLoggedIn ? "Go to Chat" : "Get Started Free"}
            </Button>
            <ul className="mt-8 space-y-3">
              {freeFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm text-slate-600">
                  <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {feature}
                </li>
              ))}
            </ul>
          </div>

          {/* Pro Plan */}
          <div className="rounded-xl border-2 border-primary-600 p-8 relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="bg-primary-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
                Most Popular
              </span>
            </div>
            <h2 className="text-lg font-semibold text-slate-900">Pro</h2>
            <p className="mt-1 text-sm text-slate-500">
              For serious legal research
            </p>
            <div className="mt-6">
              <span className="text-4xl font-bold text-slate-900">
                {"\u20B9"}{plan.price}
              </span>
              <span className="text-slate-500">{plan.period}</span>
            </div>
            {billing === "yearly" && (
              <p className="mt-1 text-sm text-green-600 font-medium">
                {plans.yearly.savings}
              </p>
            )}
            <Button
              className="w-full mt-6"
              onClick={handleSubscribe}
              disabled={subscribing}
            >
              {subscribing ? "Processing..." : "Subscribe Now"}
            </Button>
            <ul className="mt-8 space-y-3">
              {proFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-sm text-slate-600">
                  <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
