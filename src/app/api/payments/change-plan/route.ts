import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import { cancelSubscription, createSubscription } from "@/lib/razorpay";
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
    // Cancel current subscription if exists
    if (user.razorpay_subscription_id) {
      await cancelSubscription(user.razorpay_subscription_id);
    }

    // Create new subscription on the new plan
    const subscription = await createSubscription(
      user.razorpay_customer_id,
      plan
    );

    return NextResponse.json({ subscription_id: subscription.id });
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
