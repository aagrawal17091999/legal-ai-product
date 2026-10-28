import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

/**
 * The referral program end to end against a real Postgres: claim -> first
 * charge (counts at once) -> every 5th pays 2,000 credits into the wallet.
 * Analytics is captured, not sent; what's under test is our own bookkeeping,
 * because its failure mode is silent — a wrong transition doesn't throw, it
 * pays a reward twice or never.
 *
 * Needs a THROWAWAY database (it creates tables): TEST_DATABASE_URL=...
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL to run referral tests";

const SCHEMA = `
DROP TABLE IF EXISTS referral_rewards, referrals, credit_transactions, credit_balances, users CASCADE;
CREATE TABLE users (
  id SERIAL PRIMARY KEY, firebase_uid TEXT UNIQUE NOT NULL, email TEXT NOT NULL,
  display_name TEXT, photo_url TEXT, plan TEXT DEFAULT 'free',
  razorpay_customer_id TEXT, razorpay_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive', subscription_end_date TIMESTAMP,
  comped_plan BOOLEAN NOT NULL DEFAULT FALSE, unlimited_credits BOOLEAN NOT NULL DEFAULT FALSE,
  is_staff BOOLEAN NOT NULL DEFAULT FALSE, phone TEXT, referral_source TEXT,
  referral_detail TEXT, onboarded_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
CREATE TABLE credit_balances (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_credits NUMERIC NOT NULL DEFAULT 0, topup_credits NUMERIC NOT NULL DEFAULT 0,
  period_start TIMESTAMP, period_end TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT NOW());
CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, credits NUMERIC NOT NULL, razorpay_payment_id TEXT,
  razorpay_order_id TEXT, amount_inr NUMERIC, created_at TIMESTAMP NOT NULL DEFAULT NOW());
CREATE UNIQUE INDEX uq_credit_tx_payment ON credit_transactions (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;
`;

const DAY = 24 * 3600 * 1000;

let pool: Pool;
let referrals: typeof import("../index");

// Captured analytics.
const events: { event: string; userId: number | null; properties?: Record<string, unknown> }[] = [];
const profiles: { kind: string; userId: number; props: Record<string, unknown> }[] = [];

async function migrations(): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  return Promise.all(
    ["035_referrals.sql", "036_referral_credit_rewards.sql"].map((f) =>
      readFile(new URL(`../../../../migrations/${f}`, import.meta.url), "utf8")
    )
  );
}

async function makeUser(
  email: string,
  extra: Partial<{
    display_name: string;
    plan: string;
    phone: string;
    created_at: Date;
    razorpay_subscription_id: string;
    subscription_status: string;
    subscription_end_date: Date;
  }> = {}
) {
  const { rows } = await pool.query(
    `INSERT INTO users (firebase_uid, email, display_name, plan, phone, created_at,
                        razorpay_subscription_id, subscription_status, subscription_end_date)
     VALUES ($1, $1, $2, COALESCE($3, 'free'), $4, COALESCE($5, NOW()), $6,
             COALESCE($7, 'inactive'), $8)
     RETURNING *`,
    [
      email,
      extra.display_name ?? null,
      extra.plan ?? null,
      extra.phone ?? null,
      extra.created_at ?? null,
      extra.razorpay_subscription_id ?? null,
      extra.subscription_status ?? null,
      extra.subscription_end_date ?? null,
    ]
  );
  return rows[0];
}

before(async () => {
  if (!TEST_DB) return;
  pool = new Pool({ connectionString: TEST_DB });
  await pool.query(SCHEMA);
  for (const sql of await migrations()) await pool.query(sql);

  mock.module("@/lib/db", { defaultExport: pool, namedExports: {} });
  mock.module("@/lib/analytics/server", {
    namedExports: {
      track: (event: string, o: { userId: number | null; properties?: Record<string, unknown> }) =>
        void events.push({ event, userId: o.userId, properties: o.properties }),
      identify: (userId: number, props: Record<string, unknown>) =>
        void profiles.push({ kind: "set", userId, props }),
      setOnce: (userId: number, props: Record<string, unknown>) =>
        void profiles.push({ kind: "set_once", userId, props }),
      increment: (userId: number, props: Record<string, unknown>) =>
        void profiles.push({ kind: "increment", userId, props }),
    },
  });
  mock.module("@/lib/error-logger", { namedExports: { logError: () => {} } });
  referrals = await import("../index");
});

after(async () => {
  if (pool) await pool.end();
});

/** Refer `n` fresh users to `code`, and have each make their first payment. */
async function payingReferees(code: string, prefix: string, n: number) {
  for (let i = 0; i < n; i++) {
    const u = await makeUser(`${prefix}${i}@x.in`, { display_name: `Ref ${prefix}${i}` });
    const r = await referrals.claimReferral(u, code);
    assert.equal(r.ok, true);
    await referrals.recordRefereeFirstCharge({
      refereeUserId: u.id,
      paymentId: `pay_${prefix}${i}`,
      subscriptionId: `sub_${prefix}${i}`,
    });
  }
}

test("claims: valid, idempotent, and every refusal", { skip }, async () => {
  const priya = await makeUser("priya@x.in", { display_name: "Priya Sharma", phone: "+919800000001" });
  const code = await referrals.ensureReferralCode(priya);
  assert.match(code, /^PRIYA[A-Z0-9]{3}$/);
  assert.equal(await referrals.ensureReferralCode({ ...priya, referral_code: code }), code);

  const rahul = await makeUser("rahul@x.in");
  assert.deepEqual(await referrals.claimReferral(rahul, code.toLowerCase()), {
    ok: true,
    referrerName: "Priya S.",
  });
  // Same code again (retry, second tab) is a quiet success.
  assert.equal((await referrals.claimReferral(rahul, code)).ok, true);

  const other = await makeUser("other@x.in", { display_name: "Other" });
  const otherCode = await referrals.ensureReferralCode(other);
  assert.deepEqual(await referrals.claimReferral(rahul, otherCode), {
    ok: false,
    reason: "already_referred",
  });

  const fresh = await referrals.claimReferral(await makeUser("n@x.in"), "NOPE1234");
  assert.deepEqual(fresh, { ok: false, reason: "invalid_code" });
  assert.deepEqual(
    await referrals.claimReferral({ ...priya, referral_code: code }, code),
    { ok: false, reason: "self" }
  );
  const old = await makeUser("old@x.in", { created_at: new Date(Date.now() - 30 * DAY) });
  assert.deepEqual(await referrals.claimReferral(old, code), { ok: false, reason: "too_late" });
  const payer = await makeUser("payer@x.in", { plan: "monthly", razorpay_subscription_id: "sub_p" });
  assert.deepEqual(await referrals.claimReferral(payer, code), {
    ok: false,
    reason: "already_paying",
  });
  const twin = await makeUser("twin@x.in", { phone: "+919800000001" });
  assert.deepEqual(await referrals.claimReferral(twin, code), { ok: false, reason: "self" });
});

test("first charge from the referrer's own phone is disqualified", { skip }, async () => {
  const a = await makeUser("a@x.in", { display_name: "Asha", phone: "+919811111111" });
  const code = await referrals.ensureReferralCode(a);
  const b = await makeUser("b@x.in");
  await referrals.claimReferral(b, code);
  await referrals.recordRefereeFirstCharge({
    refereeUserId: b.id,
    paymentId: "pay_b",
    subscriptionId: "sub_b",
    paymentContact: "98111 11111",
  });
  const { rows } = await pool.query(
    `SELECT status, disqualified_reason FROM referrals WHERE referee_user_id = $1`,
    [b.id]
  );
  assert.deepEqual(rows[0], { status: "disqualified", disqualified_reason: "self_referral" });
});

async function walletOf(userId: number) {
  const { rows } = await pool.query(
    `SELECT plan_credits, topup_credits FROM credit_balances WHERE user_id = $1`,
    [userId]
  );
  return rows[0] ? { plan: Number(rows[0].plan_credits), topup: Number(rows[0].topup_credits) } : null;
}

test("the 5th paying referral pays 2,000 credits at once, exactly once", { skip }, async () => {
  const k = await makeUser("k@x.in", { display_name: "Kavya" });
  const code = await referrals.ensureReferralCode(k);

  await payingReferees(code, "k", 4);
  assert.equal(await walletOf(k.id), null, "nothing before the 5th");
  await payingReferees(code, "k4_", 1);
  assert.deepEqual(await walletOf(k.id), { plan: 0, topup: 2000 }, "lands in the persistent pool");

  // A retried webhook for an already-counted payer changes nothing.
  const { rows: one } = await pool.query(
    `SELECT referee_user_id FROM referrals WHERE referrer_user_id = $1 LIMIT 1`,
    [k.id]
  );
  await referrals.recordRefereeFirstCharge({
    refereeUserId: one[0].referee_user_id,
    paymentId: "pay_retry",
    subscriptionId: "sub_retry",
  });
  assert.equal(await referrals.syncRewards(k.id), 0);
  assert.equal(await referrals.settleBankedRewards(), 0);
  assert.deepEqual(await walletOf(k.id), { plan: 0, topup: 2000 });

  const { rows: ledger } = await pool.query(
    `SELECT type, credits, amount_inr FROM credit_transactions WHERE user_id = $1`,
    [k.id]
  );
  assert.deepEqual(ledger, [{ type: "referral_grant", credits: "2000", amount_inr: null }]);

  const summary = await referrals.getReferralSummary({ ...k, referral_code: code });
  assert.deepEqual(summary.counts, { signedUp: 5, qualified: 5 });
  assert.equal(summary.progress, 0);
  assert.deepEqual(summary.rewards, { earned: 1, credits: 2000 });
  assert.match(summary.referrals[0].email, /^k\*\*\*@x\.in$/);
});

test("Mixpanel: 5 paid events on the referrer, referred-by facts on the referee", { skip }, async () => {
  events.length = 0;
  profiles.length = 0;
  const m = await makeUser("mx@x.in", { display_name: "Mira" });
  const code = await referrals.ensureReferralCode(m);
  assert.deepEqual(
    profiles.find((p) => p.userId === m.id && p.kind === "set")?.props,
    { referral_code: code },
    "referrer's own code on their profile"
  );

  await payingReferees(code, "mx", 5);

  const paid = events.filter((e) => e.event === "referral_paid");
  assert.equal(paid.length, 5);
  assert.ok(paid.every((e) => e.userId === m.id), "all five on the referrer");
  assert.deepEqual(
    paid.map((e) => e.properties?.paid_referrals_total),
    [1, 2, 3, 4, 5]
  );
  assert.equal(paid[4].properties?.referral_code, code);
  assert.match(String(paid[0].properties?.referee_email), /@x\.in$/);

  const earned = events.filter((e) => e.event === "referral_reward_earned");
  assert.equal(earned.length, 1);
  assert.equal(earned[0].properties?.credits, 2000);

  const claimed = events.filter((e) => e.event === "referral_claimed");
  assert.equal(claimed.length, 5);
  const referee = claimed[0].userId!;
  assert.deepEqual(claimed[0].properties?.referral_code, code);
  const once = profiles.find((p) => p.userId === referee && p.kind === "set_once")!.props;
  assert.equal(once.referred, true);
  assert.equal(once.referral_code_used, code);
  assert.equal(once.referred_by_user_id, m.id);
  assert.equal(once.referred_by_email, "mx@x.in");
});

test("ten qualified pay twice; four pay nothing", { skip }, async () => {
  const t = await makeUser("t@x.in", { display_name: "Tara" });
  const tCode = await referrals.ensureReferralCode(t);
  await payingReferees(tCode, "t", 10);
  assert.deepEqual(await walletOf(t.id), { plan: 0, topup: 4000 });

  const f = await makeUser("f4@x.in", { display_name: "Four" });
  const fCode = await referrals.ensureReferralCode(f);
  await payingReferees(fCode, "f4_", 4);
  assert.equal(await walletOf(f.id), null);
  const summary = await referrals.getReferralSummary({ ...f, referral_code: fCode });
  assert.equal(summary.progress, 4);
});

test("a reward left banked by a crash is paid by the cron safety net", { skip }, async () => {
  const b = await makeUser("bk@x.in", { display_name: "Bina" });
  // Simulate syncRewards dying between the insert and the grant.
  await pool.query(
    `INSERT INTO referral_rewards (referrer_user_id, milestone, method, credits)
     VALUES ($1, 1, 'credits', 2000)`,
    [b.id]
  );
  assert.equal(await referrals.settleBankedRewards(), 1);
  assert.deepEqual(await walletOf(b.id), { plan: 0, topup: 2000 });
  const { rows } = await pool.query(
    `SELECT status FROM referral_rewards WHERE referrer_user_id = $1`,
    [b.id]
  );
  assert.equal(rows[0].status, "applied");
  // And never twice.
  assert.equal(await referrals.settleBankedRewards(), 0);
  assert.deepEqual(await walletOf(b.id), { plan: 0, topup: 2000 });
});
