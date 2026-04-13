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
    savings: "Save ₹6,000",
    planKey: "yearly" as const,
  },
};

const freeFeatures = [
  "5 queries per day",
  "Streaming, cited answers",
  "Supreme Court and High Court coverage",
  "Inline citations linked to source judgments",
  "PDF downloads of cited judgments",
  "Basic search filters (court, year range)",
  "Research history (last 30 days)",
];

const proFeatures = [
  "Unlimited queries",
  "Streaming, cited answers",
  "Supreme Court and High Court coverage",
  "Inline citations linked to source judgments",
  "PDF downloads of cited judgments",
  "All pre-filters: court, bench, judge, act, section, category, parties, year",
  "Full research history (unlimited retention)",
  "Priority response generation",
  "Email support",
];

const pricingFaqs = [
  {
    q: "Can I try Pro before committing?",
    a: "The free plan gives you a genuine sense of how NyayaSearch works. Five queries per day, with the same quality of cited answers as the Pro plan. The primary difference is volume: Pro removes the daily limit and unlocks all pre-filters.",
  },
  {
    q: "What payment methods do you accept?",
    a: "We accept all major Indian credit cards, debit cards, UPI, and net banking through Razorpay. All transactions are processed securely in Indian Rupees.",
  },
  {
    q: "Can I switch between monthly and annual billing?",
    a: "Yes. You can switch from monthly to annual billing at any time from your account settings. When switching to annual, you will be billed ₹30,000 for the year and save ₹6,000 compared to monthly billing.",
  },
  {
    q: "What happens if I cancel?",
    a: "You retain full access through the end of your current billing period. After that, your account reverts to the free plan. Your research history is preserved and remains accessible.",
  },
  {
    q: "Do you offer team or firm pricing?",
    a: "Not yet. NyayaSearch is currently designed for individual advocates. If you are interested in firm-wide access, contact us at hello@nyayasearch.com and we will work with you.",
  },
  {
    q: "Is GST included in the price?",
    a: "GST of 18% is charged in addition to the listed price, in compliance with Indian tax regulations. The invoice will reflect the base price plus applicable GST.",
  },
];

function Check() {
  return (
    <svg
      className="w-4 h-4 text-gold-500 shrink-0 mt-0.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

export default function PricingTeaser() {
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
                router.push("/chat");
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
    <>
      {/* Pricing header */}
      <section id="pricing" className="bg-ivory-50 pt-24 pb-12 sm:pt-32 sm:pb-16 border-t border-ivory-200">
        <div className="max-w-[1200px] mx-auto px-6 sm:px-8 text-center">
          <span className="overline">Pricing</span>
          <h2 className="mt-6 font-serif text-4xl sm:text-[44px] leading-[1.1] tracking-tight text-charcoal-900">
            Transparent pricing for
            <br />
            serious research.
          </h2>
          <p className="mt-6 max-w-xl mx-auto text-[17px] text-charcoal-600 leading-relaxed">
            Start free with five queries a day. Upgrade to Pro when your practice
            needs unlimited, citation-backed legal research.
          </p>

          {/* Billing toggle */}
          <div className="mt-10 inline-flex items-center gap-1 bg-ivory-100 border border-ivory-200 rounded-full p-1">
            <button
              onClick={() => setBilling("monthly")}
              className={`px-5 py-2 rounded-full text-[14px] font-medium transition-colors ${
                billing === "monthly"
                  ? "bg-navy-950 text-ivory-50"
                  : "text-charcoal-600 hover:text-charcoal-900"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling("yearly")}
              className={`px-5 py-2 rounded-full text-[14px] font-medium transition-colors ${
                billing === "yearly"
                  ? "bg-navy-950 text-ivory-50"
                  : "text-charcoal-600 hover:text-charcoal-900"
              }`}
            >
              Annual
              <span className={`ml-2 text-[12px] ${billing === "yearly" ? "text-gold-400" : "text-gold-600"}`}>
                Save ₹6,000
              </span>
            </button>
          </div>
        </div>
      </section>

      {/* Plan cards */}
      <section className="bg-ivory-50 pb-24 sm:pb-32">
        <div className="max-w-4xl mx-auto px-6 sm:px-8 grid md:grid-cols-2 gap-6">
          {/* Free */}
          <div className="bg-ivory-100 border border-ivory-200 rounded-xl p-8 flex flex-col">
            <h2 className="font-serif text-3xl text-charcoal-900">Starter</h2>
            <p className="mt-2 text-[14px] text-charcoal-600">
              For advocates exploring AI-powered research.
            </p>
            <div className="mt-8">
              <span className="font-serif text-5xl text-charcoal-900">₹0</span>
              <span className="text-charcoal-600 ml-1">/ forever</span>
            </div>
            <Button
              variant="outline"
              className="w-full mt-8"
              onClick={handleFreeClick}
            >
              {isLoggedIn ? "Go to Research →" : "Start Free →"}
            </Button>
            <ul className="mt-10 space-y-3">
              {freeFeatures.map((feature) => (
                <li
                  key={feature}
                  className="flex items-start gap-3 text-[14px] text-charcoal-600 leading-snug"
                >
                  <Check />
                  {feature}
                </li>
              ))}
            </ul>
          </div>

          {/* Pro */}
          <div className="bg-ivory-50 border-2 border-navy-950 rounded-xl p-8 flex flex-col relative">
            <div className="absolute -top-3 left-8">
              <span className="overline bg-gold-500 text-navy-950 px-3 py-1 rounded-full">
                Most Popular
              </span>
            </div>
            <h2 className="font-serif text-3xl text-charcoal-900">Pro</h2>
            <p className="mt-2 text-[14px] text-charcoal-600">
              For advocates who research every day.
            </p>
            <div className="mt-8">
              <span className="font-serif text-5xl text-charcoal-900">
                ₹{plan.price}
              </span>
              <span className="text-charcoal-600 ml-1">{plan.period}</span>
            </div>
            {billing === "yearly" && (
              <p className="mt-2 text-[14px] text-gold-600 font-medium">
                {plans.yearly.savings} vs monthly billing
              </p>
            )}
            <Button
              variant="primary"
              className="w-full mt-8"
              onClick={handleSubscribe}
              disabled={subscribing}
            >
              {subscribing ? "Processing…" : "Start Pro Plan →"}
            </Button>
            <ul className="mt-10 space-y-3">
              {proFeatures.map((feature) => (
                <li
                  key={feature}
                  className="flex items-start gap-3 text-[14px] text-charcoal-600 leading-snug"
                >
                  <Check />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Pricing FAQ */}
      <section className="bg-ivory-100 py-24 sm:py-32 border-t border-ivory-200">
        <div className="max-w-3xl mx-auto px-6 sm:px-8">
          <h2 className="font-serif text-3xl sm:text-4xl text-charcoal-900 mb-10">
            Pricing questions
          </h2>
          <div className="divide-y divide-ivory-200 border-y border-ivory-200">
            {pricingFaqs.map((faq) => (
              <details key={faq.q} className="group py-6">
                <summary className="flex items-start justify-between gap-6 cursor-pointer list-none">
                  <span className="font-serif text-[20px] text-charcoal-900 leading-snug">
                    {faq.q}
                  </span>
                  <span className="shrink-0 mt-1 text-gold-500 group-open:rotate-45 transition-transform">
                    <svg
                      className="w-5 h-5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </span>
                </summary>
                <p className="mt-4 pr-10 text-[15px] text-charcoal-600 leading-relaxed">
                  {faq.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
