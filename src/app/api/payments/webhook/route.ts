import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/razorpay";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

export async function POST(request: NextRequest) {
  const signature = request.headers.get("x-razorpay-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const body = await request.text();

  if (!verifyWebhookSignature(body, signature)) {
    logError({
      category: "payment",
      message: "Invalid Razorpay webhook signature",
      severity: "critical",
      endpoint: "/api/payments/webhook",
      method: "POST",
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const event = JSON.parse(body);
    const eventType = event.event;
    const payload = event.payload;

    switch (eventType) {
      case "subscription.activated": {
        const subscriptionId = payload.subscription?.entity?.id;
        const planId = payload.subscription?.entity?.plan_id;
        const customerId = payload.subscription?.entity?.customer_id;

        if (subscriptionId && customerId) {
          // Determine plan type based on plan_id (or notes)
          const plan = planId?.includes("yearly") ? "yearly" : "monthly";
          const endDate = new Date();
          endDate.setMonth(
            endDate.getMonth() + (plan === "yearly" ? 12 : 1)
          );

          await pool.query(
            `UPDATE users SET
              plan = $1,
              subscription_status = 'active',
              razorpay_subscription_id = $2,
              subscription_end_date = $3,
              updated_at = NOW()
             WHERE razorpay_customer_id = $4`,
            [plan, subscriptionId, endDate.toISOString(), customerId]
          );
        }
        break;
      }

      case "subscription.charged": {
        const subscriptionId = payload.subscription?.entity?.id;
        if (subscriptionId) {
          const endDate = new Date();
          endDate.setMonth(endDate.getMonth() + 1);

          await pool.query(
            `UPDATE users SET
              subscription_end_date = $1,
              subscription_status = 'active',
              updated_at = NOW()
             WHERE razorpay_subscription_id = $2`,
            [endDate.toISOString(), subscriptionId]
          );
        }
        break;
      }

      case "subscription.cancelled":
      case "subscription.completed": {
        const subscriptionId = payload.subscription?.entity?.id;
        if (subscriptionId) {
          await pool.query(
            `UPDATE users SET
              plan = 'free',
              subscription_status = 'inactive',
              updated_at = NOW()
             WHERE razorpay_subscription_id = $1`,
            [subscriptionId]
          );
        }
        break;
      }
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      endpoint: "/api/payments/webhook",
      method: "POST",
      metadata: { bodyLength: body.length },
    });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
