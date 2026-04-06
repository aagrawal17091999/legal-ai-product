import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import { createSubscription, createCustomer } from "@/lib/razorpay";
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

  const body = await request.json();
  const plan = body.plan as "monthly" | "yearly";

  if (!plan || !["monthly", "yearly"].includes(plan)) {
    return NextResponse.json(
      { error: "Invalid plan. Must be 'monthly' or 'yearly'" },
      { status: 400 }
    );
  }

  try {
    // Get or create Razorpay customer
    let customerId = user.razorpay_customer_id;
    if (!customerId) {
      const customer = await createCustomer(
        user.email,
        user.display_name || user.email
      );
      customerId = customer.id;
      await pool.query(
        `UPDATE users SET razorpay_customer_id = $1 WHERE id = $2`,
        [customerId, user.id]
      );
    }

    const subscription = await createSubscription(customerId, plan);

    return NextResponse.json({
      subscription_id: subscription.id,
    });
  } catch (err) {
    logError({
      category: "payment",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "critical",
      userId: user.id,
      endpoint: "/api/payments/create-subscription",
      method: "POST",
      metadata: { plan },
    });
    return NextResponse.json({ error: "Failed to create subscription" }, { status: 500 });
  }
}
