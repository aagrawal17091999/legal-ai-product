import { NextRequest, NextResponse } from "next/server";
import {
  verifyWebhookSignature,
  getPlanTypeFromId,
  markSubscriptionActive,
  subscriptionEndDate,
  subscriptionCycleKey,
  fetchOrder,
} from "@/lib/razorpay";
import pool from "@/lib/db";
import { grant, unlockOutputs } from "@/lib/billing/credits";
import { PLAN_CREDITS, creditPeriodEnd } from "@/lib/billing/cost";
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
          const currentEnd = entity?.current_end as number | null | undefined;
          const endDate = subscriptionEndDate(plan, currentEnd);
          await markSubscriptionActive({ userId, subscriptionId, plan, endDate });
          // Grant the first MONTH's Pro allowance (resets plan_credits, no
          // rollover). Idempotent per billing cycle: the charged webhook and a
          // retried activated event won't re-grant or wipe mid-cycle usage.
          // The credit period is one month even on the yearly plan — the rest of
          // the year is refilled by /api/cron/credit-refill. Granting against
          // `endDate` here is what made yearly a 12x underdelivery.
          await grant({
            userId,
            type: "monthly_reset",
            credits: PLAN_CREDITS[plan],
            periodEnd: creditPeriodEnd(plan, endDate),
            idempotencyKey: subscriptionCycleKey(subscriptionId, currentEnd),
          });
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
        const entity = payload.subscription?.entity;
        const subscriptionId = entity?.id;
        if (subscriptionId) {
          // Use Razorpay's authoritative current_end for the cycle boundary so
          // our period stays in lockstep with billing instead of drifting from
          // server-receipt time.
          const plan = getPlanTypeFromId(entity?.plan_id) ?? "monthly";
          const currentEnd = entity?.current_end as number | null | undefined;
          const endDate = subscriptionEndDate(plan, currentEnd);

          const { rows } = await pool.query<{ id: number }>(
            `UPDATE users SET
              subscription_end_date = $1,
              subscription_status = 'active',
              updated_at = NOW()
             WHERE razorpay_subscription_id = $2
             RETURNING id`,
            [endDate.toISOString(), subscriptionId]
          );
          // Refill the Pro credit pool for the new billing cycle (no rollover).
          // Idempotent per cycle so duplicate/retried charged deliveries can't
          // re-grant credits or reset a paying user's mid-cycle usage to full.
          // One month of allowance, not one billing cycle's worth — a yearly
          // subscriber's remaining 11 months come from /api/cron/credit-refill.
          if (rows[0]?.id) {
            await grant({
              userId: rows[0].id,
              type: "monthly_reset",
              credits: PLAN_CREDITS[plan],
              periodEnd: creditPeriodEnd(plan, endDate),
              idempotencyKey: subscriptionCycleKey(subscriptionId, currentEnd),
            });
          }
        }
        break;
      }

      case "payment.captured": {
        // One-time credit top-up purchases (createCreditOrder stamps notes on
        // the ORDER). Razorpay does not always copy order notes onto the payment
        // entity, so fall back to the order's notes when the payment's are bare
        // — otherwise a top-up whose Checkout callback never ran would silently
        // never be credited.
        const entity = payload.payment?.entity;
        let notes = entity?.notes ?? {};
        if (notes.kind !== "credit_topup" && entity?.order_id) {
          try {
            const order = await fetchOrder(entity.order_id);
            if (order?.notes) notes = order.notes;
          } catch {
            // Order fetch failed — fall through with the payment notes we have.
          }
        }
        if (notes.kind === "credit_topup") {
          const userId = Number(notes.user_id);
          const credits = Number(notes.credits);
          if (Number.isInteger(userId) && userId > 0 && credits > 0) {
            const { applied } = await grant({
              userId,
              type: "topup",
              credits,
              razorpayPaymentId: entity.id,
              razorpayOrderId: entity.order_id,
              amountInr: Number.isFinite(Number(entity.amount))
                ? Number(entity.amount) / 100
                : undefined,
            });
            // A top-up restores a positive balance — release any withheld outputs.
            if (applied) await unlockOutputs(userId);
          }
        }
        break;
      }

      case "subscription.cancelled":
      case "subscription.completed": {
        const cancelEntity = payload.subscription?.entity;
        const subscriptionId = cancelEntity?.id;
        // Guard against a stale/out-of-order delivery downgrading a user whose
        // subscription has since renewed: only act when the entity is in a
        // genuinely terminal state. A cycle-end cancellation fires this event
        // only once the subscription has actually ended.
        const terminal = ["cancelled", "completed", "expired"].includes(
          String(cancelEntity?.status)
        );
        if (subscriptionId && terminal) {
          const { rows } = await pool.query<{ id: number }>(
            `UPDATE users SET
              plan = 'free',
              subscription_status = 'inactive',
              updated_at = NOW()
             WHERE razorpay_subscription_id = $1
             RETURNING id`,
            [subscriptionId]
          );
          // The Pro allowance ends with the subscription — zero plan_credits so a
          // lapsed user can't keep spending the monthly pool. Purchased/lifetime
          // credits (topup_credits) are preserved.
          if (rows[0]?.id) {
            await pool.query(
              `UPDATE credit_balances
                  SET plan_credits = 0, period_end = NOW(), updated_at = NOW()
                WHERE user_id = $1`,
              [rows[0].id]
            );
          }
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
