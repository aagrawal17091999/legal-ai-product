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
    <div className="flex-1 overflow-y-auto">
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-2xl font-bold text-slate-900 mb-8">Settings</h1>

      <div className="space-y-6">
        {/* Profile */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Profile
          </h2>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-primary-100 flex items-center justify-center text-primary-600 text-xl font-bold">
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
                  <p className="font-medium text-slate-900">
                    {userData?.display_name || "—"}
                  </p>
                  <button
                    onClick={() => setEditingName(true)}
                    className="text-slate-400 hover:text-slate-600"
                    title="Edit name"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                </div>
              )}
              <p className="text-sm text-slate-500">{user?.email}</p>
            </div>
          </div>
        </div>

        {/* Subscription */}
        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Subscription
          </h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600">Current Plan</span>
              <span className="text-sm font-medium text-slate-900">
                {planLabel}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600">Queries Today</span>
              <span className="text-sm font-medium text-slate-900">
                {userData?.plan === "free"
                  ? `${userData?.queries_used_today || 0}/5`
                  : "Unlimited"}
              </span>
            </div>
            {userData?.subscription_end_date && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">Renews</span>
                <span className="text-sm font-medium text-slate-900">
                  {new Date(
                    userData.subscription_end_date
                  ).toLocaleDateString()}
                </span>
              </div>
            )}
            {userData?.subscription_status === "cancelled" && (
              <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-2">
                Your subscription has been cancelled. You retain access until the end of your billing period.
              </p>
            )}
          </div>

          <div className="mt-6 space-y-3">
            {userData?.plan === "free" ? (
              <Button
                className="w-full"
                onClick={() => setShowUpgradeModal(true)}
              >
                Upgrade to Pro
              </Button>
            ) : (
              <>
                {/* Plan switching */}
                {userData?.plan === "monthly" && userData?.subscription_status !== "cancelled" && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => handleChangePlan("yearly")}
                    disabled={changingPlan}
                  >
                    {changingPlan
                      ? "Processing..."
                      : "Switch to Yearly (Save 17%)"}
                  </Button>
                )}
                {userData?.plan === "yearly" && userData?.subscription_status !== "cancelled" && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => handleChangePlan("monthly")}
                    disabled={changingPlan}
                  >
                    {changingPlan ? "Processing..." : "Switch to Monthly"}
                  </Button>
                )}

                {/* Cancel */}
                {userData?.subscription_status !== "cancelled" && (
                  <Button
                    variant="ghost"
                    className="w-full text-red-600 hover:text-red-700 hover:bg-red-50"
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
        title="Choose a Plan"
      >
        <div className="space-y-4">
          {/* Monthly */}
          <div className="rounded-lg border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-slate-900">Pro Monthly</h4>
              <span className="text-lg font-bold text-slate-900">{"\u20B9"}3,000<span className="text-sm font-normal text-slate-500">/mo</span></span>
            </div>
            <ul className="space-y-1.5 mb-4">
              {["Unlimited queries", "All courts & filters", "Full judgment access", "Priority support"].map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-slate-600">
                  <svg className="w-3.5 h-3.5 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>
            <Button
              className="w-full"
              onClick={() => handleUpgrade("monthly")}
              disabled={upgrading !== null}
            >
              {upgrading === "monthly" ? "Processing..." : "Subscribe Monthly"}
            </Button>
          </div>

          {/* Yearly */}
          <div className="rounded-lg border-2 border-primary-600 p-4 relative">
            <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
              <span className="bg-primary-600 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
                Save 17%
              </span>
            </div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-slate-900">Pro Yearly</h4>
              <span className="text-lg font-bold text-slate-900">{"\u20B9"}30,000<span className="text-sm font-normal text-slate-500">/yr</span></span>
            </div>
            <ul className="space-y-1.5 mb-4">
              {["Unlimited queries", "All courts & filters", "Full judgment access", "Priority support", "Save \u20B96,000 vs monthly"].map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-slate-600">
                  <svg className="w-3.5 h-3.5 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {f}
                </li>
              ))}
            </ul>
            <Button
              className="w-full"
              onClick={() => handleUpgrade("yearly")}
              disabled={upgrading !== null}
            >
              {upgrading === "yearly" ? "Processing..." : "Subscribe Yearly"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Cancel Confirmation Modal */}
      <Modal
        isOpen={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        title="Cancel Subscription"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Are you sure you want to cancel your subscription? You will retain
            access to Pro features until the end of your current billing period.
            After that, your account will revert to the Free plan (5 queries/day).
          </p>
          <div className="flex gap-3 justify-end">
            <Button
              variant="outline"
              onClick={() => setShowCancelConfirm(false)}
            >
              Keep Subscription
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={handleCancelSubscription}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling..." : "Yes, Cancel"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
    </div>
  );
}
