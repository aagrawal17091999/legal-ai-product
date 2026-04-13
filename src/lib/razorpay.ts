import Razorpay from "razorpay";
import crypto from "crypto";
import pool from "@/lib/db";

function getClient(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.local"
    );
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

// Plan IDs — set these after creating plans in Razorpay dashboard
const PLAN_IDS = {
  monthly: process.env.RAZORPAY_PLAN_MONTHLY || "",
  yearly: process.env.RAZORPAY_PLAN_YEARLY || "",
};

export async function createSubscription(
  customerId: string,
  plan: "monthly" | "yearly",
  userId: number
) {
  const client = getClient();
  const planId = PLAN_IDS[plan];

  if (!planId) {
    throw new Error(`Razorpay plan ID for "${plan}" is not configured`);
  }

  // notes is the only reliable way to link a Razorpay subscription back to
  // our user row: subscription.customer_id on the response is assigned by
  // Razorpay based on who authenticates at checkout and may not match the
  // customer we pre-created. notes is server-set and tamper-proof.
  const subscription = await client.subscriptions.create({
    plan_id: planId,
    total_count: plan === "monthly" ? 12 : 1,
    quantity: 1,
    customer_notify: 1,
    notes: {
      user_id: String(userId),
      customer_id: customerId,
      plan_type: plan,
    },
  } as Parameters<typeof client.subscriptions.create>[0]);

  return subscription;
}

export async function createCustomer(email: string, name: string) {
  const client = getClient();
  const customer = await client.customers.create({
    name,
    email,
  });
  return customer;
}

export async function cancelSubscription(subscriptionId: string) {
  const client = getClient();
  return await client.subscriptions.cancel(subscriptionId);
}

export async function fetchSubscription(subscriptionId: string) {
  const client = getClient();
  return await client.subscriptions.fetch(subscriptionId);
}

/**
 * Map a Razorpay plan_id back to our internal plan type by matching against
 * the configured env vars. Using an explicit map avoids fragile string matching
 * on plan IDs that may not contain the word "monthly"/"yearly".
 */
export function getPlanTypeFromId(
  planId: string | null | undefined
): "monthly" | "yearly" | null {
  if (!planId) return null;
  if (planId === PLAN_IDS.monthly) return "monthly";
  if (planId === PLAN_IDS.yearly) return "yearly";
  return null;
}

export function computeSubscriptionEndDate(plan: "monthly" | "yearly"): Date {
  const endDate = new Date();
  if (plan === "yearly") {
    endDate.setFullYear(endDate.getFullYear() + 1);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }
  return endDate;
}

/**
 * Single source of truth for flipping a user's row to an active paid plan.
 * Called from both the webhook handler and the client-verify route, so it
 * must be idempotent — running it twice with the same args is a no-op.
 *
 * Keyed by our internal `userId` (not razorpay_customer_id) because
 * Razorpay assigns its own customer_id during checkout that may not match
 * the customer we pre-created.
 */
export async function markSubscriptionActive(opts: {
  userId: number;
  subscriptionId: string;
  plan: "monthly" | "yearly";
}): Promise<{ endDate: Date; updated: boolean }> {
  const endDate = computeSubscriptionEndDate(opts.plan);
  const result = await pool.query(
    `UPDATE users SET
       plan = $1,
       subscription_status = 'active',
       razorpay_subscription_id = $2,
       subscription_end_date = $3,
       updated_at = NOW()
     WHERE id = $4`,
    [opts.plan, opts.subscriptionId, endDate.toISOString(), opts.userId]
  );
  return { endDate, updated: (result.rowCount ?? 0) > 0 };
}

export function verifyWebhookSignature(
  body: string,
  signature: string
): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET is not configured");
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
