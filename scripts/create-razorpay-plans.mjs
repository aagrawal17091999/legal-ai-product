/**
 * One-time script to create Razorpay subscription plans.
 * Run with: node scripts/create-razorpay-plans.mjs
 *
 * After running, copy the plan IDs into .env.local:
 *   RAZORPAY_PLAN_MONTHLY=plan_xxx
 *   RAZORPAY_PLAN_YEARLY=plan_xxx
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
const envPath = resolve(import.meta.dirname, "../.env.local");
const envContent = readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const keyId = env.RAZORPAY_KEY_ID;
const keySecret = env.RAZORPAY_KEY_SECRET;

if (!keyId || !keySecret) {
  console.error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in .env.local");
  process.exit(1);
}

const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

async function createPlan(name, period, interval, amount) {
  const res = await fetch("https://api.razorpay.com/v1/plans", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      period,
      interval,
      item: {
        name,
        amount, // in paise
        currency: "INR",
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(`Failed to create ${name}:`, data);
    return null;
  }
  return data;
}

console.log("Creating Razorpay subscription plans...\n");

const monthly = await createPlan("NyayaSearch Pro Monthly", "monthly", 1, 300000);
if (monthly) {
  console.log(`Monthly plan created: ${monthly.id}`);
}

const yearly = await createPlan("NyayaSearch Pro Yearly", "yearly", 1, 3000000);
if (yearly) {
  console.log(`Yearly plan created: ${yearly.id}`);
}

if (monthly && yearly) {
  console.log(`\nAdd these to your .env.local:\n`);
  console.log(`RAZORPAY_PLAN_MONTHLY=${monthly.id}`);
  console.log(`RAZORPAY_PLAN_YEARLY=${yearly.id}`);
}
