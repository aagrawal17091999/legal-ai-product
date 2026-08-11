import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { verifyPaymentSignature, fetchOrder } from "@/lib/razorpay";
import { grant, unlockOutputs, getBalance } from "@/lib/billing/credits";
import { logError } from "@/lib/error-logger";

/**
 * POST /api/payments/credits/verify
 * Body: { orderId, paymentId, signature }
 *
 * Confirms a credit top-up immediately after Razorpay Checkout succeeds (the
 * webhook payment.captured is the reliable fallback; both are idempotent via the
 * unique payment-id index). Credits are read from the ORDER's server-set notes —
 * never the client — so a tampered request can't grant more than was paid for.
 */
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const body = await request.json().catch(() => ({}));
    const orderId = String(body.orderId || "");
    const paymentId = String(body.paymentId || "");
    const signature = String(body.signature || "");
    if (!orderId || !paymentId || !signature) {
      return NextResponse.json({ error: "Missing payment fields" }, { status: 400 });
    }

    if (!verifyPaymentSignature({ orderId, paymentId, signature })) {
      return NextResponse.json({ error: "Invalid payment signature" }, { status: 400 });
    }

    // Source of truth for the grant: the order's server-set notes, not the client.
    const order = await fetchOrder(orderId);
    const notes = (order.notes ?? {}) as Record<string, string>;
    const noteUserId = Number(notes.user_id);
    const credits = Number(notes.credits);
    // Ledger the EX-GST base, not order.amount (which is GST-inclusive) — tax we
    // collect and remit is not revenue, and amount_inr feeds margin analytics.
    // Older orders predate notes.base_inr; fall back to the gross figure.
    const baseInr = Number(notes.base_inr);
    if (notes.kind !== "credit_topup" || noteUserId !== user.id || !(credits > 0)) {
      return NextResponse.json({ error: "Order does not match this user" }, { status: 400 });
    }

    const { applied } = await grant({
      userId: user.id,
      type: "topup",
      credits,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      amountInr: Number.isFinite(baseInr) && baseInr > 0
        ? baseInr
        : typeof order.amount === "number"
          ? order.amount / 100
          : undefined,
    });
    if (applied) await unlockOutputs(user.id);

    const balance = await getBalance(user.id);
    return NextResponse.json({ ok: true, applied, remaining: balance.remaining });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/payments/credits/verify",
      method: "POST",
    });
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
