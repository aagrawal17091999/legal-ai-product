"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/ui/Modal";
import Input from "@/components/ui/Input";
import Button from "@/components/ui/Button";
import { useAuth } from "@/hooks/useAuth";
import {
  REFERRAL_SOURCES,
  REFERRAL_DETAIL_MAX,
  normalizeIndianMobile,
  type ReferralSource,
} from "@/lib/onboarding";

// Deliberately not dismissable: no close button, and Escape / backdrop clicks
// route to this no-op. The only way out is submitting the form.
const noop = () => {};

/**
 * Post-signup step: mobile number + how they heard about us. Shown on any
 * protected page until the server says the user has completed it.
 */
export default function OnboardingModal() {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState<ReferralSource | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch("/api/user", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.needs_onboarding) setOpen(true);
      } catch {
        /* If this check fails, let them in rather than block the app. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!normalizeIndianMobile(phone)) {
      setError("Enter a valid 10-digit Indian mobile number.");
      return;
    }
    if (!source) {
      setError("Tell us how you heard about Legal Brain.");
      return;
    }
    if (source === "other" && !detail.trim()) {
      setError("Tell us where you heard about Legal Brain.");
      return;
    }

    setSubmitting(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/user/onboarding", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          phone,
          referral_source: source,
          referral_detail: source === "other" ? detail : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong. Please try again.");
        return;
      }
      setOpen(false);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={noop}>
      <form onSubmit={handleSubmit}>
        <span className="overline">One quick step</span>
        <h3 className="mt-4 font-serif text-2xl text-charcoal-900 leading-tight">
          Welcome to Legal Brain
        </h3>
        <p className="mt-3 text-[14px] text-charcoal-600 leading-relaxed">
          Legal Brain is early, and we&apos;d like to hear how it&apos;s working
          for you. We use your number to gather feedback, to support you, and
          in our product analytics — never for marketing, and never sold.
        </p>

        <div className="mt-6">
          <Input
            label="Mobile number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </div>

        <fieldset className="mt-6">
          <legend className="block text-[14px] font-medium text-charcoal-600 mb-2">
            How did you hear about us?
          </legend>
          <div className="flex flex-wrap gap-2">
            {REFERRAL_SOURCES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSource(s.value)}
                aria-pressed={source === s.value}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors ${
                  source === s.value
                    ? "border-navy-950 bg-navy-950 text-ivory-50"
                    : "border-ivory-200 bg-ivory-100 text-charcoal-900 hover:border-gold-400"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {source === "other" && (
            <div className="mt-3">
              <Input
                placeholder="Where did you hear about us?"
                value={detail}
                maxLength={REFERRAL_DETAIL_MAX}
                onChange={(e) => setDetail(e.target.value)}
              />
            </div>
          )}
        </fieldset>

        {error && <p className="mt-4 text-[13px] text-burgundy-700">{error}</p>}

        <Button type="submit" className="w-full mt-6" disabled={submitting}>
          {submitting ? "Saving…" : "Continue →"}
        </Button>
      </form>
    </Modal>
  );
}
