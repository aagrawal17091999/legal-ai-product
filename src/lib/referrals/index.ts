/**
 * The referral program (migrations 035, 036).
 *
 * The lifecycle of one referral:
 *   1. claimReferral()             a new user attaches a code    -> signed_up
 *   2. recordRefereeFirstCharge()  their first subscription charge -> pending
 *   3. qualifyDueReferrals()       7 days on, no refund           -> qualified
 *   4. syncRewards()               every 5 qualified = 2,000 credits in the
 *                                  referrer's wallet (top-up pool, never expire)
 */
import crypto from "crypto";
import pool from "@/lib/db";
import { fetchPayment } from "@/lib/razorpay";
import { grant } from "@/lib/billing/credits";
import { normalizeIndianMobile } from "@/lib/onboarding";
import { SITE_URL } from "@/lib/site";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";
import type { User } from "@/types";
import {
  REFERRALS_PER_REWARD,
  REFERRAL_REWARD_CREDITS,
  REFERRAL_PENDING_DAYS,
  REFERRAL_CLAIM_WINDOW_DAYS,
  normalizeReferralCode,
  type ReferralSummary,
  type ReferralStatus,
} from "./shared";

// No 0/O, 1/I/L: codes get read out over the phone and typed from WhatsApp.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomSuffix(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** "Priya Sharma" -> "PRIYA"; falls back to the email's local part. */
function codeStem(displayName: string | null, email: string): string {
  const source = displayName?.trim().split(/\s+/)[0] || email.split("@")[0];
  const letters = source.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  return letters.length >= 2 ? letters : "LB";
}

export function referralLink(code: string): string {
  return `${SITE_URL}/r/${code}`;
}

/**
 * The user's referral code, allocated on first use. Collisions on the unique
 * index are retried with a fresh suffix; a concurrent allocation for the same
 * user (two tabs) settles on whichever write landed first.
 */
export async function ensureReferralCode(
  user: Pick<User, "id" | "display_name" | "email"> & { referral_code?: string | null }
): Promise<string> {
  if (user.referral_code) return user.referral_code;
  const stem = codeStem(user.display_name, user.email);
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = `${stem}${randomSuffix(attempt < 3 ? 3 : 5)}`;
    try {
      const { rows } = await pool.query<{ referral_code: string }>(
        `UPDATE users SET referral_code = $1
          WHERE id = $2 AND referral_code IS NULL
          RETURNING referral_code`,
        [candidate, user.id]
      );
      if (rows[0]) return rows[0].referral_code;
      const existing = await pool.query<{ referral_code: string | null }>(
        `SELECT referral_code FROM users WHERE id = $1`,
        [user.id]
      );
      if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
    }
  }
  throw new Error(`Could not allocate a referral code for user ${user.id}`);
}

/** "Priya Sharma" -> "Priya S." — what a stranger holding the code may see. */
export function publicName(displayName: string | null): string {
  const parts = displayName?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return "A colleague";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

/** "rahul@gmail.com" -> "r***@gmail.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function findReferrerByCode(
  rawCode: string
): Promise<{ id: number; display_name: string | null; email: string; phone: string | null } | null> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  const { rows } = await pool.query(
    `SELECT id, display_name, email, phone FROM users WHERE referral_code = $1`,
    [code]
  );
  return rows[0] ?? null;
}

export type ClaimResult =
  | { ok: true; referrerName: string }
  | {
      ok: false;
      reason: "invalid_code" | "self" | "already_referred" | "too_late" | "already_paying";
    };

/**
 * Attach a referral code to a newly created account.
 *
 * Only a genuinely new, never-paid account can be referred, and only once.
 * Re-claiming the same code is a no-op success, so a retried request or a
 * second tab doesn't surface an error.
 */
export async function claimReferral(referee: User, rawCode: string): Promise<ClaimResult> {
  const code = normalizeReferralCode(rawCode);
  const referrer = code ? await findReferrerByCode(code) : null;
  if (!code || !referrer) return { ok: false, reason: "invalid_code" };
  if (referrer.id === referee.id) return { ok: false, reason: "self" };

  const existing = await pool.query<{ referrer_user_id: number }>(
    `SELECT referrer_user_id FROM referrals WHERE referee_user_id = $1`,
    [referee.id]
  );
  if (existing.rows[0]) {
    return existing.rows[0].referrer_user_id === referrer.id
      ? { ok: true, referrerName: publicName(referrer.display_name) }
      : { ok: false, reason: "already_referred" };
  }

  if (referee.plan !== "free" || referee.razorpay_subscription_id) {
    return { ok: false, reason: "already_paying" };
  }
  const ageMs = Date.now() - new Date(referee.created_at).getTime();
  if (ageMs > REFERRAL_CLAIM_WINDOW_DAYS * 24 * 3600 * 1000) {
    return { ok: false, reason: "too_late" };
  }
  // Same mobile number on both accounts: one person with two logins.
  if (referee.phone && referrer.phone && referee.phone === referrer.phone) {
    return { ok: false, reason: "self" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO referrals (referrer_user_id, referee_user_id, code_used)
       VALUES ($1, $2, $3)
       ON CONFLICT (referee_user_id) DO NOTHING
       RETURNING id`,
      [referrer.id, referee.id, code]
    );
    if (inserted.rows.length === 0) {
      // Lost a race with a concurrent claim; whichever landed first stands.
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_referred" };
    }
    await client.query(
      `UPDATE users SET referred_by_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [referrer.id, referee.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  track(EVENTS.REFERRAL_CLAIMED, {
    userId: referee.id,
    insertId: `ref_claim:${referee.id}`,
    properties: { referrer_user_id: referrer.id, referral_code: code },
  });
  return { ok: true, referrerName: publicName(referrer.display_name) };
}

/**
 * Called from the subscription.charged webhook on a user's FIRST subscription
 * charge. Starts the 7-day pending window, or disqualifies outright when the
 * payment plainly came from the referrer (their phone or email on the payment).
 * A no-op for users who weren't referred, or whose referral already moved on.
 */
export async function recordRefereeFirstCharge(opts: {
  refereeUserId: number;
  paymentId: string | null;
  subscriptionId: string;
  paymentEmail?: string | null;
  paymentContact?: string | null;
}): Promise<void> {
  const { rows } = await pool.query<{
    id: number;
    referrer_user_id: number;
    referrer_email: string;
    referrer_phone: string | null;
  }>(
    `SELECT r.id, r.referrer_user_id, u.email AS referrer_email, u.phone AS referrer_phone
       FROM referrals r JOIN users u ON u.id = r.referrer_user_id
      WHERE r.referee_user_id = $1 AND r.status = 'signed_up'`,
    [opts.refereeUserId]
  );
  const ref = rows[0];
  if (!ref) return;

  const contact = opts.paymentContact ? normalizeIndianMobile(opts.paymentContact) : null;
  const selfPaid =
    (contact && ref.referrer_phone && contact === ref.referrer_phone) ||
    (opts.paymentEmail &&
      opts.paymentEmail.toLowerCase() === ref.referrer_email.toLowerCase());

  if (selfPaid) {
    await pool.query(
      `UPDATE referrals SET status = 'disqualified', disqualified_reason = 'self_referral',
              first_payment_id = $2, first_subscription_id = $3, first_paid_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND status = 'signed_up'`,
      [ref.id, opts.paymentId, opts.subscriptionId]
    );
    track(EVENTS.REFERRAL_DISQUALIFIED, {
      userId: ref.referrer_user_id,
      insertId: `ref_dq:${ref.id}`,
      properties: { referee_user_id: opts.refereeUserId, reason: "self_referral" },
    });
    return;
  }

  const updated = await pool.query(
    `UPDATE referrals SET status = 'pending',
            first_payment_id = $2, first_subscription_id = $3, first_paid_at = NOW(),
            qualifies_at = NOW() + ($4 || ' days')::interval, updated_at = NOW()
      WHERE id = $1 AND status = 'signed_up'`,
    [ref.id, opts.paymentId, opts.subscriptionId, String(REFERRAL_PENDING_DAYS)]
  );
  if ((updated.rowCount ?? 0) > 0) {
    track(EVENTS.REFERRAL_FIRST_PAYMENT, {
      userId: ref.referrer_user_id,
      insertId: `ref_paid:${ref.id}`,
      properties: {
        referee_user_id: opts.refereeUserId,
        razorpay_payment_id: opts.paymentId,
        razorpay_subscription_id: opts.subscriptionId,
      },
    });
  }
}

/**
 * Settle every pending referral whose window has passed: qualified if the
 * first payment still stands, disqualified if it was refunded. A payment we
 * can't fetch right now stays pending and is retried on the next run.
 */
export async function qualifyDueReferrals(): Promise<{
  qualified: number;
  disqualified: number;
  deferred: number;
  rewardsEarned: number;
}> {
  const { rows } = await pool.query<{
    id: number;
    referrer_user_id: number;
    referee_user_id: number;
    first_payment_id: string | null;
  }>(
    `SELECT id, referrer_user_id, referee_user_id, first_payment_id
       FROM referrals
      WHERE status = 'pending' AND qualifies_at <= NOW()
      ORDER BY qualifies_at
      LIMIT 200`
  );

  let qualified = 0;
  let disqualified = 0;
  let deferred = 0;
  let rewardsEarned = 0;

  for (const r of rows) {
    let refunded = false;
    if (r.first_payment_id) {
      try {
        const p = await fetchPayment(r.first_payment_id);
        refunded = Number(p.amount_refunded) > 0 || p.status === "refunded";
      } catch {
        deferred++;
        continue;
      }
    }

    if (refunded) {
      const res = await pool.query(
        `UPDATE referrals SET status = 'disqualified', disqualified_reason = 'refunded',
                updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [r.id]
      );
      if ((res.rowCount ?? 0) > 0) {
        disqualified++;
        track(EVENTS.REFERRAL_DISQUALIFIED, {
          userId: r.referrer_user_id,
          insertId: `ref_dq:${r.id}`,
          properties: { referee_user_id: r.referee_user_id, reason: "refunded" },
        });
      }
      continue;
    }

    const res = await pool.query(
      `UPDATE referrals SET status = 'qualified', qualified_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [r.id]
    );
    if ((res.rowCount ?? 0) > 0) {
      qualified++;
      track(EVENTS.REFERRAL_QUALIFIED, {
        userId: r.referrer_user_id,
        insertId: `ref_ok:${r.id}`,
        properties: { referee_user_id: r.referee_user_id },
      });
      rewardsEarned += await syncRewards(r.referrer_user_id);
    }
  }

  return { qualified, disqualified, deferred, rewardsEarned };
}

/**
 * Pay out one reward per REFERRALS_PER_REWARD qualified referrals: 2,000
 * credits into the referrer's top-up pool. Returns how many NEW rewards this
 * call earned.
 *
 * Two idempotent steps, so a crash between them is repaired by the next call
 * (the hourly cron calls settleBankedRewards for everyone):
 *   1. insert the missing milestones as 'banked' — UNIQUE (referrer, milestone)
 *      means recomputing floor(qualified / 5) can never mint a reward twice;
 *   2. grant every banked reward, keyed 'refreward:<id>' in the ledger, then
 *      mark it 'applied'.
 */
export async function syncRewards(referrerUserId: number): Promise<number> {
  const { rows: countRows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM referrals
      WHERE referrer_user_id = $1 AND status = 'qualified'`,
    [referrerUserId]
  );
  const earned = Math.floor(Number(countRows[0].n) / REFERRALS_PER_REWARD);
  let inserted = 0;
  if (earned > 0) {
    const res = await pool.query(
      `INSERT INTO referral_rewards (referrer_user_id, milestone, method, credits)
       SELECT $1, g, 'credits', $3 FROM generate_series(1, $2::int) AS g
       ON CONFLICT (referrer_user_id, milestone) DO NOTHING`,
      [referrerUserId, earned, REFERRAL_REWARD_CREDITS]
    );
    inserted = res.rowCount ?? 0;
  }
  await payBankedRewards(referrerUserId);
  return inserted;
}

async function payBankedRewards(referrerUserId: number): Promise<void> {
  const { rows } = await pool.query<{ id: number; milestone: number; credits: number | null }>(
    `SELECT id, milestone, credits FROM referral_rewards
      WHERE referrer_user_id = $1 AND status = 'banked'
      ORDER BY milestone`,
    [referrerUserId]
  );
  for (const r of rows) {
    const credits = r.credits ?? REFERRAL_REWARD_CREDITS;
    const { applied } = await grant({
      userId: referrerUserId,
      type: "referral_grant",
      credits,
      idempotencyKey: `refreward:${r.id}`,
    });
    await pool.query(
      `UPDATE referral_rewards
          SET status = 'applied', method = 'credits', credits = $2, actor = 'system',
              applied_at = COALESCE(applied_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND status = 'banked'`,
      [r.id, credits]
    );
    if (applied) {
      track(EVENTS.REFERRAL_REWARD_EARNED, {
        userId: referrerUserId,
        insertId: `ref_reward:${r.id}`,
        properties: { reward_id: r.id, milestone: r.milestone, credits },
      });
    }
  }
}

/** Cron safety net: pay any reward left banked by an interrupted syncRewards. */
export async function settleBankedRewards(): Promise<number> {
  const { rows } = await pool.query<{ referrer_user_id: number }>(
    `SELECT DISTINCT referrer_user_id FROM referral_rewards WHERE status = 'banked'`
  );
  for (const r of rows) await payBankedRewards(r.referrer_user_id);
  return rows.length;
}

/** Everything the referrer's own "Refer & earn" section shows. */
export async function getReferralSummary(user: User): Promise<ReferralSummary> {
  const code = await ensureReferralCode(user);

  const [refs, rewards] = await Promise.all([
    pool.query<{
      display_name: string | null;
      email: string;
      status: ReferralStatus;
      created_at: string;
      first_paid_at: string | null;
      qualifies_at: string | null;
    }>(
      `SELECT u.display_name, u.email, r.status, r.created_at, r.first_paid_at, r.qualifies_at
         FROM referrals r JOIN users u ON u.id = r.referee_user_id
        WHERE r.referrer_user_id = $1
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [user.id]
    ),
    pool.query<{ n: string; credits: string | null }>(
      `SELECT COUNT(*) AS n, SUM(credits) AS credits FROM referral_rewards
        WHERE referrer_user_id = $1 AND status = 'applied'`,
      [user.id]
    ),
  ]);

  const counts = { signedUp: 0, pending: 0, qualified: 0 };
  for (const r of refs.rows) {
    if (r.status === "pending") counts.pending++;
    else if (r.status === "qualified") counts.qualified++;
    if (r.status !== "disqualified") counts.signedUp++;
  }

  return {
    code,
    link: referralLink(code),
    perReward: REFERRALS_PER_REWARD,
    creditsPerReward: REFERRAL_REWARD_CREDITS,
    counts,
    progress: counts.qualified % REFERRALS_PER_REWARD,
    rewards: {
      earned: Number(rewards.rows[0].n),
      credits: Number(rewards.rows[0].credits ?? 0),
    },
    referrals: refs.rows.map((r) => ({
      name: publicName(r.display_name),
      email: maskEmail(r.email),
      status: r.status,
      joinedAt: r.created_at,
      firstPaidAt: r.first_paid_at,
      qualifiesAt: r.qualifies_at,
    })),
  };
}
