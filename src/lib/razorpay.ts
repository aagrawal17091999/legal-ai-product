import Razorpay from "razorpay";
import crypto from "crypto";

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
  plan: "monthly" | "yearly"
) {
  const client = getClient();
  const planId = PLAN_IDS[plan];

  if (!planId) {
    throw new Error(`Razorpay plan ID for "${plan}" is not configured`);
  }

  const subscription = await client.subscriptions.create({
    plan_id: planId,
    total_count: plan === "monthly" ? 12 : 1,
    quantity: 1,
    customer_notify: 1,
    notes: { customer_id: customerId },
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
