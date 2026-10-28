import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

/**
 * The referral program end to end against a real Postgres: claim -> first
 * charge -> 7-day window -> banked month -> pause -> free month's credits ->
 * chain -> resume, plus the refund method and staff undo. Razorpay is stubbed;
 * what's under test is our own bookkeeping, because its failure mode is silent
 * — a wrong state transition doesn't throw, it gives a month away or loses one.
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
let rewards: typeof import("../rewards");

// Razorpay stub state.
const calls: string[] = [];
let chargeAt = 0;
let refundedPayments = new Set<string>();

async function migration(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../../../../migrations/035_referrals.sql", import.meta.url), "utf8");
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
  await pool.query(await migration());

  mock.module("@/lib/db", { defaultExport: pool, namedExports: {} });
  mock.module("@/lib/analytics/server", { namedExports: { track: () => {} } });
  mock.module("@/lib/error-logger", { namedExports: { logError: () => {} } });
  mock.module("@/lib/razorpay", {
    namedExports: {
      fetchPayment: async (id: string) => ({
        id,
        status: refundedPayments.has(id) ? "refunded" : "captured",
        amount_refunded: refundedPayments.has(id) ? 295000 : 0,
      }),
      fetchSubscription: async (id: string) => {
        calls.push(`fetch:${id}`);
        return { id, status: "active", charge_at: chargeAt / 1000 };
      },
      pauseSubscription: async (id: string) => void calls.push(`pause:${id}`),
      resumeSubscription: async (id: string) => void calls.push(`resume:${id}`),
      refundPayment: async (id: string) => {
        calls.push(`refund:${id}`);
        return { id: `rfnd_${id}` };
      },
    },
  });

  referrals = await import("../index");
  rewards = await import("../rewards");
});

after(async () => {
  if (pool) await pool.end();
});

/** Refer `n` fresh users to `referrerId`'s code and push them all to qualified. */
async function qualifyReferees(code: string, prefix: string, n: number) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = await makeUser(`${prefix}${i}@x.in`, { display_name: `Ref ${prefix}${i}` });
    const r = await referrals.claimReferral(u, code);
    assert.equal(r.ok, true);
    await referrals.recordRefereeFirstCharge({
      refereeUserId: u.id,
      paymentId: `pay_${prefix}${i}`,
      subscriptionId: `sub_${prefix}${i}`,
    });
    ids.push(u.id);
  }
  await pool.query(
    `UPDATE referrals SET qualifies_at = NOW() - interval '1 minute'
      WHERE referee_user_id = ANY($1::int[])`,
    [ids]
  );
  return referrals.qualifyDueReferrals();
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

test("5 qualified = 1 banked month; a refund inside the window doesn't count", { skip }, async () => {
  const k = await makeUser("k@x.in", { display_name: "Kavya" });
  const code = await referrals.ensureReferralCode(k);

  refundedPayments = new Set(["pay_k5"]);
  // Six referees; one is refunded inside the window -> 5 qualified.
  const res = await qualifyReferees(code, "k", 6);
  assert.deepEqual(res, { qualified: 5, disqualified: 1, deferred: 0, monthsEarned: 1 });

  // Re-running mints nothing new.
  assert.equal(await referrals.syncRewards(k.id), 0);
  const summary = await referrals.getReferralSummary({ ...k, referral_code: code });
  assert.equal(summary.counts.qualified, 5);
  assert.equal(summary.progress, 0);
  assert.deepEqual(summary.months, { earned: 1, banked: 1, applied: 0 });
  assert.equal(summary.referrals.length, 6);
  assert.match(summary.referrals[0].email, /^k\*\*\*@x\.in$/);
});

test("pause flow: schedule -> free-month credits -> chain -> resume", { skip }, async () => {
  const renewal = new Date(Date.now() + 2 * DAY);
  const m = await makeUser("m@x.in", {
    display_name: "Meera",
    plan: "monthly",
    subscription_status: "active",
    razorpay_subscription_id: "sub_m",
    subscription_end_date: renewal,
  });
  const code = await referrals.ensureReferralCode(m);
  await qualifyReferees(code, "m", 10); // two months banked
  chargeAt = renewal.getTime();
  calls.length = 0;

  // Not automated: the cron's due list still finds it.
  const due = await rewards.findDueRewardWork();
  const mine = due.toSchedule.filter((d) => d.user_id === m.id);
  assert.equal(mine.length, 1, "only the earliest banked month is due at once");

  const run = await rewards.runDueRewardWork({ toSchedule: mine, toComplete: [] });
  assert.deepEqual(run, { scheduled: 1, completed: 0, failed: 0 });
  assert.deepEqual(calls, ["fetch:sub_m", "pause:sub_m"]);

  const { rows: sched } = await pool.query(
    `SELECT id, cycle_start, cycle_end FROM referral_rewards
      WHERE referrer_user_id = $1 AND status = 'scheduled'`,
    [m.id]
  );
  assert.equal(sched.length, 1);
  const first = sched[0];
  const { rows: u1 } = await pool.query(`SELECT subscription_end_date FROM users WHERE id = $1`, [m.id]);
  assert.deepEqual(u1[0].subscription_end_date, first.cycle_end, "stays Pro through the free month");

  // A second schedule while one is in progress is refused.
  const { rows: banked } = await pool.query(
    `SELECT id FROM referral_rewards WHERE referrer_user_id = $1 AND status = 'banked'`,
    [m.id]
  );
  await assert.rejects(
    rewards.scheduleReward(banked[0].id, { actor: "staff@x.in", force: true }),
    /already in progress/
  );

  // The skipped renewal arrives: credits are granted once.
  await pool.query(
    `UPDATE referral_rewards SET cycle_start = NOW() - interval '1 hour',
            cycle_end = NOW() + interval '1 hour' WHERE id = $1`,
    [first.id]
  );
  assert.equal(await rewards.grantDueFreeMonthCredits(), 1);
  assert.equal(await rewards.grantDueFreeMonthCredits(), 0);
  const { rows: bal } = await pool.query(`SELECT plan_credits FROM credit_balances WHERE user_id = $1`, [m.id]);
  assert.equal(Number(bal[0].plan_credits), 2000);

  // Month ends with another banked: chain, no Razorpay call.
  calls.length = 0;
  assert.deepEqual(await rewards.completeReward(first.id, { actor: "cron" }), { status: "chained" });
  assert.deepEqual(calls, []);
  const { rows: next } = await pool.query(
    `SELECT id, cycle_start FROM referral_rewards WHERE referrer_user_id = $1 AND status = 'scheduled'`,
    [m.id]
  );
  assert.equal(next.length, 1);
  assert.notEqual(next[0].id, first.id);

  // Last month ends: resume.
  await pool.query(
    `UPDATE referral_rewards SET cycle_start = NOW() - interval '2 hours',
            cycle_end = NOW() + interval '1 hour' WHERE id = $1`,
    [next[0].id]
  );
  assert.deepEqual(await rewards.completeReward(next[0].id, { actor: "cron" }), { status: "resumed" });
  assert.deepEqual(calls, ["resume:sub_m"]);
  const { rows: done } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM referral_rewards WHERE referrer_user_id = $1 GROUP BY status`,
    [m.id]
  );
  assert.deepEqual(done, [{ status: "applied", n: 2 }]);
});

test("not due yet: the cron leaves a renewal more than 3 days out alone", { skip }, async () => {
  const far = new Date(Date.now() + 20 * DAY);
  const f = await makeUser("f@x.in", {
    display_name: "Farah",
    plan: "monthly",
    subscription_status: "active",
    razorpay_subscription_id: "sub_f",
    subscription_end_date: far,
  });
  const code = await referrals.ensureReferralCode(f);
  await qualifyReferees(code, "f", 5);
  const due = await rewards.findDueRewardWork();
  assert.equal(due.toSchedule.filter((d) => d.user_id === f.id).length, 0);

  // Staff "Apply now" goes early; "Undo" before the renewal banks it again.
  chargeAt = far.getTime();
  calls.length = 0;
  const { rows } = await pool.query(`SELECT id FROM referral_rewards WHERE referrer_user_id = $1`, [f.id]);
  const applied = await rewards.scheduleReward(rows[0].id, { actor: "staff@x.in", force: true });
  assert.equal(applied.status, "scheduled");
  assert.deepEqual(await rewards.completeReward(rows[0].id, { actor: "staff@x.in", force: true }), {
    status: "undone",
  });
  assert.deepEqual(calls, ["fetch:sub_f", "pause:sub_f", "resume:sub_f"]);
  const { rows: after } = await pool.query(
    `SELECT r.status, u.subscription_end_date FROM referral_rewards r
       JOIN users u ON u.id = r.referrer_user_id WHERE r.id = $1`,
    [rows[0].id]
  );
  assert.equal(after[0].status, "banked");
  assert.deepEqual(after[0].subscription_end_date, far, "renewal date restored");
});

test("refund method: the booked renewal is refunded exactly once", { skip }, async () => {
  process.env.REFERRAL_REWARD_METHOD = "refund";
  try {
    const renewal = new Date(Date.now() + DAY);
    const r = await makeUser("r@x.in", {
      display_name: "Rohan",
      plan: "monthly",
      subscription_status: "active",
      razorpay_subscription_id: "sub_r",
      subscription_end_date: renewal,
    });
    const code = await referrals.ensureReferralCode(r);
    await qualifyReferees(code, "r", 5);
    chargeAt = renewal.getTime();
    calls.length = 0;

    const { rows } = await pool.query(`SELECT id FROM referral_rewards WHERE referrer_user_id = $1`, [r.id]);
    const res = await rewards.scheduleReward(rows[0].id, { actor: "cron" });
    assert.equal(res.status === "scheduled" && res.method, "refund");
    assert.deepEqual(calls, ["fetch:sub_r"], "no pause in refund mode");

    const opts = { userId: r.id, subscriptionId: "sub_r", paymentId: "pay_renewal" };
    assert.equal(await rewards.refundBookedRenewal(opts), true);
    assert.equal(await rewards.refundBookedRenewal(opts), false, "a retried webhook can't refund twice");
    assert.deepEqual(calls.filter((c) => c.startsWith("refund")), ["refund:pay_renewal"]);
  } finally {
    delete process.env.REFERRAL_REWARD_METHOD;
  }
});

test("yearly always pauses, even in refund mode", { skip }, async () => {
  process.env.REFERRAL_REWARD_METHOD = "refund";
  try {
    const renewal = new Date(Date.now() + DAY);
    const y = await makeUser("y@x.in", {
      display_name: "Yash",
      plan: "yearly",
      subscription_status: "active",
      razorpay_subscription_id: "sub_y",
      subscription_end_date: renewal,
    });
    const code = await referrals.ensureReferralCode(y);
    await qualifyReferees(code, "y", 5);
    chargeAt = renewal.getTime();
    const { rows } = await pool.query(`SELECT id FROM referral_rewards WHERE referrer_user_id = $1`, [y.id]);
    const res = await rewards.scheduleReward(rows[0].id, { actor: "cron" });
    assert.equal(res.status === "scheduled" && res.method, "pause");
    // Yearly credits come from the refill cron, not here.
    await pool.query(`UPDATE referral_rewards SET cycle_start = NOW() - interval '1 hour' WHERE id = $1`, [
      rows[0].id,
    ]);
    const { rows: before } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM credit_transactions WHERE razorpay_payment_id = $1`,
      [`refreward:${rows[0].id}`]
    );
    await rewards.grantDueFreeMonthCredits();
    const { rows: afterRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM credit_transactions WHERE razorpay_payment_id = $1`,
      [`refreward:${rows[0].id}`]
    );
    assert.equal(afterRows[0].n, before[0].n);
  } finally {
    delete process.env.REFERRAL_REWARD_METHOD;
  }
});

test("cancelling forfeits every unused month, including one in progress", { skip }, async () => {
  const renewal = new Date(Date.now() + DAY);
  const c = await makeUser("c@x.in", {
    display_name: "Chitra",
    plan: "monthly",
    subscription_status: "active",
    razorpay_subscription_id: "sub_c",
    subscription_end_date: renewal,
  });
  const code = await referrals.ensureReferralCode(c);
  await qualifyReferees(code, "c", 10); // two months
  chargeAt = renewal.getTime();
  const { rows } = await pool.query(
    `SELECT id FROM referral_rewards WHERE referrer_user_id = $1 ORDER BY milestone`,
    [c.id]
  );
  await rewards.scheduleReward(rows[0].id, { actor: "cron" });
  assert.equal(await rewards.freeMonthInProgress(c.id), true);

  assert.equal(await rewards.forfeitRewards(c.id, "cancelled"), 2);
  assert.equal(await rewards.forfeitRewards(c.id, "cancelled"), 0, "idempotent");
  assert.equal(await rewards.freeMonthInProgress(c.id), false);
  const { rows: after } = await pool.query(
    `SELECT DISTINCT status FROM referral_rewards WHERE referrer_user_id = $1`,
    [c.id]
  );
  assert.deepEqual(after, [{ status: "forfeited" }]);

  // Forfeited milestones stay used: re-syncing mints nothing back.
  assert.equal(await referrals.syncRewards(c.id), 0);
  // Nothing forfeited is ever picked up by the cron again.
  const due = await rewards.findDueRewardWork();
  assert.equal(due.toSchedule.filter((d) => d.user_id === c.id).length, 0);
});
