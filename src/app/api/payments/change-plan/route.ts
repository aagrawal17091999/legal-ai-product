import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import { createSubscription, updateSubscriptionPlan } from "@/lib/razorpay";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";

export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await getOrCreateUser({
    uid: decoded.uid,
    email: decoded.email,
  });

  const body = await request.json();
  const plan = body.plan as "monthly" | "yearly";

  if (!plan || !["monthly", "yearly"].includes(plan)) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  if (plan === user.plan) {
    return NextResponse.json(
      { error: "Already on this plan" },
      { status: 400 }
    );
  }

  if (!user.razorpay_customer_id) {
    return NextResponse.json(
      { error: "No customer record. Please contact support." },
      { status: 400 }
    );
  }

  try {
    // If the user already has a live subscription, switch it in place rather
    // than cancel-then-recreate. The old code cancelled first and returned a
    // brand-new (unpaid) subscription id; if the user abandoned that checkout
    // they were left with a cancelled subscription and no replacement. An
    // in-place update keeps the same subscription_id active throughout, with
    // Razorpay handling proration ("now"), so there is no window with no plan.
    if (user.razorpay_subscription_id) {
      await updateSubscriptionPlan(user.razorpay_subscription_id, plan, "now");
      track(EVENTS.SUBSCRIPTION_PLAN_CHANGED, {
        userId: user.id,
        properties: {
          from_plan: user.plan,
          to_plan: plan,
          mode: "in_place",
          razorpay_subscription_id: user.razorpay_subscription_id,
        },
      });
      return NextResponse.json({
        subscription_id: user.razorpay_subscription_id,
        updated: true,
      });
    }

    // No existing subscription: create a fresh one (normal upgrade flow).
    const subscription = await createSubscription(
      user.razorpay_customer_id,
      plan,
      user.id
    );

    // A fresh, still-unpaid subscription: this is a checkout start, and the
    // payment itself arrives as subscription_activated.
    track(EVENTS.CHECKOUT_STARTED, {
      userId: user.id,
      properties: {
        kind: "subscription",
        plan,
        existing_plan: user.plan,
        via: "change_plan",
        razorpay_subscription_id: subscription.id,
        razorpay_customer_id: user.razorpay_customer_id,
      },
    });

    return NextResponse.json({ subscription_id: subscription.id, updated: false });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: user.id,
      endpoint: "/api/payments/change-plan",
      method: "POST",
    });
    return NextResponse.json(
      { error: "Failed to change plan" },
      { status: 500 }
    );
  }
}
