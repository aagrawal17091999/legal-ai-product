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
    // Razorpay requires a finite total_count. A small count (12 / 1) made every
    // subscription auto-`complete` after a year and silently downgrade the user
    // to free. Use a very large count so the subscription renews until the user
    // (or we) explicitly cancel it. SUBSCRIPTION_TOTAL_COUNT ≈ 100 years.
    total_count: SUBSCRIPTION_TOTAL_COUNT[plan],
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

/** Effectively-unbounded billing-cycle counts so subscriptions don't auto-expire. */
const SUBSCRIPTION_TOTAL_COUNT = { monthly: 1200, yearly: 100 } as const;

/**
 * Switch an existing subscription to a different plan in place, instead of
 * cancel-then-recreate (which stranded a paying user with no active sub if they
 * abandoned the new checkout). `schedule_change_at: "now"` swaps immediately
 * with proration; "cycle_end" defers to the next renewal. Returns the updated
 * subscription. The existing subscription_id is preserved, so no webhook
 * cutover is needed.
 */
export async function updateSubscriptionPlan(
  subscriptionId: string,
  plan: "monthly" | "yearly",
  scheduleChangeAt: "now" | "cycle_end" = "now"
) {
  const client = getClient();
  const planId = PLAN_IDS[plan];
  if (!planId) throw new Error(`Razorpay plan ID for "${plan}" is not configured`);
  return client.subscriptions.update(subscriptionId, {
    plan_id: planId,
    total_count: SUBSCRIPTION_TOTAL_COUNT[plan],
    schedule_change_at: scheduleChangeAt,
    customer_notify: 1,
  });
}

export async function createCustomer(email: string, name: string) {
  const client = getClient();
  const customer = await client.customers.create({
    name,
    email,
  });
  return customer;
}

/**
 * Create a one-time Razorpay ORDER for a credit top-up pack (distinct from the
 * recurring subscription). The tier's credits + user are stamped into `notes`
 * so the verify route / webhook can grant the right amount, tamper-proof.
 */
export async function createCreditOrder(opts: {
  userId: number;
  tierId: string;
  credits: number;
  amountInr: number;
}) {
  const client = getClient();
  return client.orders.create({
    amount: Math.round(opts.amountInr * 100), // paise
    currency: "INR",
    notes: {
      user_id: String(opts.userId),
      tier_id: opts.tierId,
      credits: String(opts.credits),
      kind: "credit_topup",
    },
  });
}

/** Fetch an order (to read its server-set `notes` during payment verification). */
export async function fetchOrder(orderId: string) {
  const client = getClient();
  return client.orders.fetch(orderId);
}

/**
 * Verify a Razorpay checkout signature for a one-time order payment:
 * HMAC_SHA256(order_id + "|" + payment_id, key_secret) === razorpay_signature.
 */
export function verifyPaymentSignature(opts: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new Error("RAZORPAY_KEY_SECRET is not configured");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${opts.orderId}|${opts.paymentId}`)
    .digest("hex");
  const a = Buffer.from(opts.signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Cancel a subscription. Defaults to cancel-at-cycle-end so a user who cancels
 * mid-cycle keeps the access they already paid for until period end (immediate
 * cancellation forfeited the remaining paid days). Pass cancelAtCycleEnd=false
 * to cancel immediately.
 */
export async function cancelSubscription(
  subscriptionId: string,
  cancelAtCycleEnd = true
) {
  const client = getClient();
  return await client.subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
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
 * Prefer Razorpay's authoritative `current_end` (Unix seconds) for the period
 * boundary; only fall back to a wall-clock estimate when the webhook entity
 * omits it. Using the real cycle end keeps our period in lockstep with billing
 * instead of drifting from server-receipt time.
 */
export function subscriptionEndDate(
  plan: "monthly" | "yearly",
  currentEnd?: number | null
): Date {
  if (typeof currentEnd === "number" && currentEnd > 0) {
    return new Date(currentEnd * 1000);
  }
  return computeSubscriptionEndDate(plan);
}

/**
 * Deterministic idempotency key for a subscription's per-cycle credit reset.
 * Stored in credit_transactions.razorpay_payment_id (partial unique index), so
 * the activated webhook, the charged webhook, and the synchronous verify route
 * all dedupe to a single monthly_reset per billing cycle regardless of delivery
 * order or retries. Keyed on the cycle's current_end so each new cycle gets a
 * fresh grant.
 */
export function subscriptionCycleKey(
  subscriptionId: string,
  currentEnd?: number | null
): string {
  return `subreset:${subscriptionId}:${currentEnd ?? "init"}`;
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
  /** Authoritative period end (from Razorpay current_end). Falls back to a
   *  wall-clock estimate when not supplied. */
  endDate?: Date;
}): Promise<{ endDate: Date; updated: boolean }> {
  const endDate = opts.endDate ?? computeSubscriptionEndDate(opts.plan);
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

  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  // timingSafeEqual throws on length mismatch — guard first so a malformed
  // signature header returns false instead of throwing an uncaught 500 (which
  // would make Razorpay retry the webhook forever).
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
