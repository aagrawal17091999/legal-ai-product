import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import {
  fetchSubscription,
  getPlanTypeFromId,
  markSubscriptionActive,
} from "@/lib/razorpay";
import { logError } from "@/lib/error-logger";

/**
 * Client-side verification endpoint for a completed Razorpay subscription checkout.
 *
 * The Razorpay Checkout `handler` callback receives { razorpay_payment_id,
 * razorpay_subscription_id, razorpay_signature } when a subscription payment
 * succeeds. We verify the HMAC signature with RAZORPAY_KEY_SECRET (NOT the
 * webhook secret), fetch the subscription from Razorpay to confirm status,
 * and flip the user's row to the paid plan synchronously.
 *
 * This makes test-mode upgrades work without a webhook tunnel, and acts as a
 * fast-path in prod that the async webhook then reconfirms idempotently.
 */
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await getOrCreateUser({
    uid: decoded.uid,
    email: decoded.email,
  });

  let body: {
    razorpay_payment_id?: string;
    razorpay_subscription_id?: string;
    razorpay_signature?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } =
    body ?? {};
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return NextResponse.json(
      { error: "Missing razorpay_payment_id, razorpay_subscription_id, or razorpay_signature" },
      { status: 400 }
    );
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    return NextResponse.json(
      { error: "Razorpay is not configured" },
      { status: 500 }
    );
  }

  // Razorpay subscription signature formula:
  //   hmac_sha256(razorpay_payment_id + "|" + razorpay_subscription_id, key_secret)
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(razorpay_signature, "utf8");
  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    // Fetch the subscription from Razorpay to get the authoritative plan_id,
    // notes, and status — don't trust client-supplied values beyond the
    // signature check.
    const subscription = (await fetchSubscription(
      razorpay_subscription_id
    )) as {
      status?: string;
      plan_id?: string;
      notes?: Record<string, string | number>;
    };

    const status = subscription.status;
    if (!status || !["active", "authenticated", "charged"].includes(status)) {
      return NextResponse.json(
        { error: `Subscription not active (status=${status ?? "unknown"})` },
        { status: 400 }
      );
    }

    const plan = getPlanTypeFromId(subscription.plan_id);
    if (!plan) {
      logError({
        category: "payment",
        message: `Unknown plan_id on verified subscription: ${subscription.plan_id}`,
        severity: "critical",
        userId: user.id,
        endpoint: "/api/payments/verify-subscription",
        method: "POST",
      });
      return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
    }

    // Verify the authenticated user owns this subscription via notes.user_id
    // which we set server-side during create-subscription. This is tamper-proof
    // because the user never sees or controls the subscription's notes.
    const notesUserId = subscription.notes?.user_id;
    if (String(notesUserId) !== String(user.id)) {
      logError({
        category: "payment",
        message: "Subscription notes.user_id mismatch during verify",
        severity: "critical",
        userId: user.id,
        endpoint: "/api/payments/verify-subscription",
        method: "POST",
        metadata: {
          expected: user.id,
          got: notesUserId ?? null,
        },
      });
      return NextResponse.json(
        { error: "Subscription does not belong to user" },
        { status: 403 }
      );
    }

    const { endDate } = await markSubscriptionActive({
      userId: user.id,
      subscriptionId: razorpay_subscription_id,
      plan,
    });

    return NextResponse.json({
      plan,
      subscription_status: "active",
      subscription_end_date: endDate.toISOString(),
    });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: user.id,
      endpoint: "/api/payments/verify-subscription",
      method: "POST",
    });
    return NextResponse.json(
      { error: "Failed to verify subscription" },
      { status: 500 }
    );
  }
}
