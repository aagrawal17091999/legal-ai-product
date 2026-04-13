"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";

interface UserData {
  id: number;
  email: string;
  display_name: string | null;
  plan: string;
  queries_used_today: number;
  subscription_status: string;
  subscription_end_date: string | null;
}

export default function AccountPage() {
  const { user, getToken } = useAuth();
  const [userData, setUserData] = useState<UserData | null>(null);

  // Name editing
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");

  // Cancel subscription
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Change plan
  const [changingPlan, setChangingPlan] = useState(false);

  // Upgrade modal
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgrading, setUpgrading] = useState<"monthly" | "yearly" | null>(null);

  useEffect(() => {
    fetchUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken]);

  async function fetchUser() {
    const token = await getToken();
    if (!token) return;
    const res = await fetch("/api/user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      setUserData(data);
      setNewName(data.display_name || "");
    }
  }

  async function handleSaveName() {
    const trimmed = newName.trim();
    if (!trimmed) {
      setNameError("Name cannot be empty");
      return;
    }
    if (trimmed.length > 100) {
      setNameError("Name must be 100 characters or less");
      return;
    }

    setSavingName(true);
    setNameError("");

    try {
      const token = await getToken();
      const res = await fetch("/api/user", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ display_name: trimmed }),
      });

      if (res.ok) {
        const updated = await res.json();
        setUserData(updated);
        setEditingName(false);
        // Reload to pick up new Firebase displayName
        await user?.reload();
      } else {
        const err = await res.json();
        setNameError(err.error || "Failed to update name");
      }
    } catch {
      setNameError("Failed to update name");
    } finally {
      setSavingName(false);
    }
  }

  async function handleCancelSubscription() {
    setCancelling(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/payments/cancel-subscription", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        setShowCancelConfirm(false);
        await fetchUser();
      }
    } catch {
      // Error handled silently
    } finally {
      setCancelling(false);
    }
  }

  async function handleChangePlan(newPlan: "monthly" | "yearly") {
    setChangingPlan(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/payments/change-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: newPlan }),
      });

      if (res.ok) {
        const data = await res.json();
        // Open Razorpay checkout for the new subscription
        if (data.subscription_id && typeof window !== "undefined") {
          const razorpayKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
          if (razorpayKeyId) {
            const options = {
              key: razorpayKeyId,
              subscription_id: data.subscription_id,
              name: "NyayaSearch",
              description: `Pro ${newPlan === "monthly" ? "Monthly" : "Yearly"} Plan`,
              handler: async () => {
                // Payment success — refresh user data
                await fetchUser();
              },
            };
            const rzp = new (window as unknown as { Razorpay: new (opts: typeof options) => { open: () => void } }).Razorpay(options);
            rzp.open();
          }
        }
      }
    } catch {
      // Error handled silently
    } finally {
      setChangingPlan(false);
    }
  }

  async function handleUpgrade(plan: "monthly" | "yearly") {
    setUpgrading(plan);
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
            handler: async () => {
              setShowUpgradeModal(false);
              await fetchUser();
            },
          };
          const rzp = new (window as unknown as { Razorpay: new (opts: typeof options) => { open: () => void } }).Razorpay(options);
          rzp.open();
        }
      }
    } catch {
      // Error handled silently
    } finally {
      setUpgrading(null);
    }
  }

  const planLabel = {
    free: "Free",
    monthly: "Pro Monthly",
    yearly: "Pro Yearly",
  }[userData?.plan || "free"];

  const isPro = userData?.plan === "monthly" || userData?.plan === "yearly";

  return (
    <div className="flex-1 overflow-y-auto bg-ivory-50">
    <div className="max-w-2xl mx-auto px-6 py-12 sm:py-16">
      <div className="mb-10">
        <span className="overline">Account</span>
        <h1 className="mt-5 font-serif text-4xl text-charcoal-900 tracking-tight">
          Account Settings.
        </h1>
      </div>

      <div className="space-y-6">
        {/* Profile */}
        <div className="bg-ivory-100 rounded-xl border border-ivory-200 p-8">
          <h2 className="font-serif text-2xl text-charcoal-900 mb-2">
            Profile
          </h2>
          <p className="text-[14px] text-charcoal-600 mb-6">
            Your account information.
          </p>
          <div className="flex items-center gap-5">
            <div className="w-16 h-16 rounded-full bg-navy-950 text-ivory-50 flex items-center justify-center font-serif text-2xl">
              {(userData?.display_name || user?.email)?.[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1">
              {editingName ? (
                <div className="space-y-2">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    error={nameError}
                    placeholder="Enter your name"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveName();
                      if (e.key === "Escape") {
                        setEditingName(false);
                        setNewName(userData?.display_name || "");
                        setNameError("");
                      }
                    }}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleSaveName}
                      disabled={savingName}
                    >
                      {savingName ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingName(false);
                        setNewName(userData?.display_name || "");
                        setNameError("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <p className="text-[17px] font-medium text-charcoal-900">
                    {userData?.display_name || "—"}
                  </p>
                  <button
                    onClick={() => setEditingName(true)}
                    className="text-charcoal-400 hover:text-charcoal-900 transition-colors"
                    title="Edit name"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                </div>
              )}
              <p className="text-[14px] text-charcoal-600">{user?.email}</p>
            </div>
          </div>
        </div>

        {/* Subscription */}
        <div className="bg-ivory-100 rounded-xl border border-ivory-200 p-8">
          <h2 className="font-serif text-2xl text-charcoal-900 mb-2">
            Subscription
          </h2>
          <p className="text-[14px] text-charcoal-600 mb-6">
            Manage your plan and billing.
          </p>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-ivory-200">
              <span className="text-[14px] text-charcoal-600">Current plan</span>
              <span className="text-[14px] font-medium text-charcoal-900">
                {planLabel}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-ivory-200">
              <span className="text-[14px] text-charcoal-600">Queries today</span>
              <span className="text-[14px] font-medium text-charcoal-900 font-mono">
                {userData?.plan === "free"
                  ? `${userData?.queries_used_today || 0} / 5`
                  : "Unlimited"}
              </span>
            </div>
            {userData?.subscription_end_date && (
              <div className="flex items-center justify-between py-2 border-b border-ivory-200">
                <span className="text-[14px] text-charcoal-600">Renews</span>
                <span className="text-[14px] font-medium text-charcoal-900">
                  {new Date(
                    userData.subscription_end_date
                  ).toLocaleDateString()}
                </span>
              </div>
            )}
            {userData?.subscription_status === "cancelled" && (
              <p className="text-[13px] text-burgundy-700 bg-burgundy-100 rounded-lg px-4 py-3 leading-relaxed">
                Your subscription has been cancelled. You retain access until the end of your billing period.
              </p>
            )}
          </div>

          <div className="mt-6 space-y-3">
            {userData?.plan === "free" ? (
              <Button
                variant="primary"
                className="w-full"
                onClick={() => setShowUpgradeModal(true)}
              >
                Upgrade to Pro →
              </Button>
            ) : (
              <>
                {userData?.plan === "monthly" && userData?.subscription_status !== "cancelled" && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => handleChangePlan("yearly")}
                    disabled={changingPlan}
                  >
                    {changingPlan
                      ? "Processing…"
                      : "Switch to Annual (save 17%)"}
                  </Button>
                )}
                {userData?.plan === "yearly" && userData?.subscription_status !== "cancelled" && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => handleChangePlan("monthly")}
                    disabled={changingPlan}
                  >
                    {changingPlan ? "Processing…" : "Switch to Monthly"}
                  </Button>
                )}

                {userData?.subscription_status !== "cancelled" && (
                  <Button
                    variant="destructive"
                    className="w-full"
                    onClick={() => setShowCancelConfirm(true)}
                  >
                    Cancel Subscription
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Upgrade Plan Modal */}
      <Modal
        isOpen={showUpgradeModal}
        onClose={() => setShowUpgradeModal(false)}
        title="Choose a plan"
      >
        <div className="space-y-4">
          {/* Monthly */}
          <div className="rounded-xl border border-ivory-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-serif text-xl text-charcoal-900">Pro Monthly</h4>
              <span className="font-serif text-2xl text-charcoal-900">
                ₹3,000<span className="text-[13px] font-sans text-charcoal-600">/mo</span>
              </span>
            </div>
            <ul className="space-y-1.5 mb-5">
              {["Unlimited queries", "All courts & filters", "Full judgment access", "Priority support"].map((f) => (
                <li key={f} className="flex items-center gap-2 text-[13px] text-charcoal-600">
                  <svg className="w-3.5 h-3.5 text-gold-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleUpgrade("monthly")}
              disabled={upgrading !== null}
            >
              {upgrading === "monthly" ? "Processing…" : "Subscribe Monthly"}
            </Button>
          </div>

          {/* Yearly */}
          <div className="rounded-xl border-2 border-navy-950 p-5 relative">
            <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
              <span className="bg-gold-500 text-navy-950 text-[11px] font-semibold uppercase tracking-wider px-3 py-0.5 rounded-full">
                Save 17%
              </span>
            </div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-serif text-xl text-charcoal-900">Pro Annual</h4>
              <span className="font-serif text-2xl text-charcoal-900">
                ₹30,000<span className="text-[13px] font-sans text-charcoal-600">/yr</span>
              </span>
            </div>
            <ul className="space-y-1.5 mb-5">
              {["Unlimited queries", "All courts & filters", "Full judgment access", "Priority support", "Save ₹6,000 vs monthly"].map((f) => (
                <li key={f} className="flex items-center gap-2 text-[13px] text-charcoal-600">
                  <svg className="w-3.5 h-3.5 text-gold-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>
            <Button
              variant="primary"
              className="w-full"
              onClick={() => handleUpgrade("yearly")}
              disabled={upgrading !== null}
            >
              {upgrading === "yearly" ? "Processing…" : "Subscribe Annual →"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Cancel Confirmation Modal */}
      <Modal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        title="Cancel subscription"
      >
        <div className="space-y-5">
          <p className="text-[15px] text-charcoal-600 leading-relaxed">
            Are you sure you want to cancel your subscription? You will retain
            access to Pro features until the end of your current billing period.
            After that, your account will revert to the Starter plan (5 queries
            per day).
          </p>
          <div className="flex gap-3 justify-end">
            <Button
              variant="outline"
              onClick={() => setShowCancelConfirm(false)}
            >
              Keep Subscription
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelSubscription}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Yes, cancel"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
    </div>
  );
}
