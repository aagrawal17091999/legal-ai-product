import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import { cancelSubscription } from "@/lib/razorpay";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import { forfeitRewards, freeMonthInProgress } from "@/lib/referrals/rewards";

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
    // Referral rule: cancelling forfeits every unused free month. If one is
    // running right now (subscription paused), nothing was paid for this period,
    // so the subscription ends immediately — access and plan credits included.
    if (await freeMonthInProgress(user.id)) {
      await cancelSubscription(user.razorpay_subscription_id, false);
      await pool.query(
        `UPDATE users SET plan = 'free', subscription_status = 'inactive',
                subscription_end_date = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [user.id]
      );
      await pool.query(
        `UPDATE credit_balances SET plan_credits = 0, period_end = NOW(), updated_at = NOW()
          WHERE user_id = $1`,
        [user.id]
      );
      const forfeited = await forfeitRewards(user.id, "cancelled during a free month");
      track(EVENTS.SUBSCRIPTION_CANCELLED, {
        userId: user.id,
        properties: {
          plan: user.plan,
          cancelled_by: "user",
          at_cycle_end: false,
          during_referral_month: true,
          referral_months_forfeited: forfeited,
          razorpay_subscription_id: user.razorpay_subscription_id,
        },
      });
      return NextResponse.json({ status: "cancelled", access_until: null, immediate: true });
    }

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

    const forfeited = await forfeitRewards(user.id, "cancelled");

    track(EVENTS.SUBSCRIPTION_CANCELLED, {
      userId: user.id,
      properties: {
        plan: user.plan,
        cancelled_by: "user",
        at_cycle_end: true,
        referral_months_forfeited: forfeited,
        access_until: user.subscription_end_date,
        razorpay_subscription_id: user.razorpay_subscription_id,
      },
    });

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
