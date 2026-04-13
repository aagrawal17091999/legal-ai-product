import { NextRequest, NextResponse } from "next/server";
import {
  verifyWebhookSignature,
  getPlanTypeFromId,
  markSubscriptionActive,
} from "@/lib/razorpay";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";

export async function POST(request: NextRequest) {
  // Safety net: if the webhook secret isn't configured, don't 500 — Razorpay
  // would retry indefinitely against a misconfigured deploy. Log loudly and
  // ack so the dashboard stops hammering us.
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    logError({
      category: "payment",
      message: "Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set",
      severity: "critical",
      endpoint: "/api/payments/webhook",
      method: "POST",
    });
    return NextResponse.json({ status: "skipped" });
  }

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
        const entity = payload.subscription?.entity;
        const subscriptionId = entity?.id;
        const planId = entity?.plan_id;
        const notesUserId = entity?.notes?.user_id;
        const userId = notesUserId ? Number(notesUserId) : NaN;

        if (subscriptionId && Number.isInteger(userId) && userId > 0) {
          const plan = getPlanTypeFromId(planId);
          if (!plan) {
            logError({
              category: "payment",
              message: `Unknown plan_id in subscription.activated webhook: ${planId}`,
              severity: "critical",
              endpoint: "/api/payments/webhook",
              method: "POST",
              metadata: { subscriptionId, userId },
            });
            break;
          }
          await markSubscriptionActive({ userId, subscriptionId, plan });
        } else {
          logError({
            category: "payment",
            message: "subscription.activated webhook missing subscriptionId or notes.user_id",
            severity: "critical",
            endpoint: "/api/payments/webhook",
            method: "POST",
            metadata: { subscriptionId, notesUserId },
          });
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
