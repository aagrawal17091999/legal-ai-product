import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import { createSubscription, updateSubscriptionPlan } from "@/lib/razorpay";
import { logError } from "@/lib/error-logger";

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
