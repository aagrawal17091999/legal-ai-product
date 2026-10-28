/**
 * Payment events that more than one route can emit.
 *
 * A top-up is confirmed by whichever of /api/payments/credits/verify (Checkout
 * callback) or the payment.captured webhook applies the grant first. Both call
 * this so the event is identical either way, and both key it on the payment id
 * so Mixpanel keeps one.
 */
import { track, increment } from "./server";
import { EVENTS } from "./events";

export function trackTopupPurchased(p: {
  userId: number;
  credits: number;
  tierId?: string;
  /** Ex-GST rupees, from the order's notes.base_inr. */
  baseInr: number;
  /** GST-inclusive amount Razorpay charged, in paise. */
  grossPaise: number;
  paymentId: string;
  orderId: string;
  method?: string;
  confirmedBy: "checkout" | "webhook";
}): void {
  const base = Number.isFinite(p.baseInr) && p.baseInr > 0 ? p.baseInr : null;
  const gross = Number.isFinite(p.grossPaise) ? p.grossPaise / 100 : null;
  track(EVENTS.TOPUP_PURCHASED, {
    userId: p.userId,
    insertId: `topup:${p.paymentId}`,
    properties: {
      credits: p.credits,
      tier_id: p.tierId ?? null,
      amount_inr_ex_gst: base,
      amount_inr_gross: gross,
      razorpay_payment_id: p.paymentId,
      razorpay_order_id: p.orderId,
      payment_method: p.method ?? null,
      confirmed_by: p.confirmedBy,
    },
  });
  // Safe to increment: callers only reach here when grant() reports `applied`,
  // which the payment-id unique index makes true exactly once per payment.
  increment(p.userId, {
    topups_purchased: 1,
    topup_credits_purchased: p.credits,
    ...(base ? { lifetime_topup_inr_ex_gst: base } : {}),
  });
}
