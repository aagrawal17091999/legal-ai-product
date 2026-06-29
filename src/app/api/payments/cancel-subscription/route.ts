import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import { cancelSubscription } from "@/lib/razorpay";
import pool from "@/lib/db";
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

  if (!user.razorpay_subscription_id) {
    return NextResponse.json(
      { error: "No active subscription" },
      { status: 400 }
    );
  }

  try {
    // Cancel at cycle end (the default) — the user keeps the access and credits
    // they already paid for until the period expires. Razorpay fires
    // subscription.cancelled at cycle end, and only then does the webhook zero
    // plan_credits. We do NOT zero credits here.
    await cancelSubscription(user.razorpay_subscription_id, true);

    // Reflect the pending cancellation for the UI; access remains until period
    // end (subscription_end_date). The webhook flips plan→free at cycle end.
    await pool.query(
      `UPDATE users SET subscription_status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    return NextResponse.json({
      status: "cancelled",
      access_until: user.subscription_end_date ?? null,
    });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: user.id,
      endpoint: "/api/payments/cancel-subscription",
      method: "POST",
    });
    return NextResponse.json(
      { error: "Failed to cancel subscription" },
      { status: 500 }
    );
  }
}
