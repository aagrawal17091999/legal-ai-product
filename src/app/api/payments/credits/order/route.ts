import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { getTopupTier } from "@/lib/billing/cost";
import { createCreditOrder } from "@/lib/razorpay";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";

/**
 * POST /api/payments/credits/order
 * Body: { tierId }  → creates a one-time Razorpay order for a credit top-up pack.
 * Returns the order details the client hands to Razorpay Checkout.
 */
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const body = await request.json().catch(() => ({}));
    const tier = getTopupTier(String(body.tierId));
    if (!tier) {
      return NextResponse.json({ error: "Unknown top-up tier" }, { status: 400 });
    }

    const order = await createCreditOrder({
      userId: user.id,
      tierId: tier.id,
      credits: tier.credits,
      amountInr: tier.priceInr,
    });

    track(EVENTS.CHECKOUT_STARTED, {
      userId: user.id,
      properties: { kind: "topup", tier_id: tier.id, credits: tier.credits },
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      tier: { id: tier.id, credits: tier.credits, priceInr: tier.priceInr },
    });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/payments/credits/order",
      method: "POST",
    });
    return NextResponse.json({ error: "Could not create order" }, { status: 500 });
  }
}
