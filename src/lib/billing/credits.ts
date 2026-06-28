/**
 * Credit wallet — balance reads, the atomic debit, and grants/resets.
 *
 * Balance model (see migration 023):
 *   remaining = plan_credits + topup_credits
 *   plan_credits  — Pro allowance, reset to PLAN_CREDITS each billing cycle.
 *   topup_credits — free lifetime grant + purchased packs; persistent.
 * Debits drain plan_credits first, then topup_credits, and may go one action
 * negative. requireCredits() blocks NEW work once remaining <= 0.
 */
import type { PoolClient } from "pg";
import pool from "@/lib/db";
import { PLAN_CREDITS } from "./cost";

/** Thrown by requireCredits() when the wallet is empty. Map to HTTP 402. */
export class OutOfCreditsError extends Error {
  remaining: number;
  constructor(remaining: number) {
    super("Insufficient credits");
    this.name = "OutOfCreditsError";
    this.remaining = remaining;
  }
}

export interface Balance {
  planCredits: number;
  topupCredits: number;
  remaining: number;
  periodStart: string | null;
  periodEnd: string | null;
}

/** Read the current wallet, materializing an empty row if the user has none. */
export async function getBalance(userId: number): Promise<Balance> {
  const { rows } = await pool.query(
    `SELECT plan_credits, topup_credits, period_start, period_end
       FROM credit_balances WHERE user_id = $1`,
    [userId]
  );
  if (rows.length === 0) {
    return { planCredits: 0, topupCredits: 0, remaining: 0, periodStart: null, periodEnd: null };
  }
  const r = rows[0];
  const plan = Number(r.plan_credits);
  const topup = Number(r.topup_credits);
  return {
    planCredits: plan,
    topupCredits: topup,
    remaining: plan + topup,
    periodStart: r.period_start,
    periodEnd: r.period_end,
  };
}

export async function getRemaining(userId: number): Promise<number> {
  return (await getBalance(userId)).remaining;
}

/**
 * Gate at the start of a billable action. Allows the request through as long as
 * the wallet has ANY positive balance (the in-flight action is permitted to
 * overshoot into the negative once); blocks entirely once remaining <= 0.
 *
 * Never blocks in shadow mode (BILLING_ENFORCE !== "on"): when nothing is being
 * debited, a zero or missing balance is meaningless and must not 402. Read the
 * env directly to avoid a cycle with meter.ts (which imports this module).
 */
export async function requireCredits(userId: number): Promise<void> {
  if (process.env.BILLING_ENFORCE !== "on") return;
  const remaining = await getRemaining(userId);
  if (remaining <= 0) throw new OutOfCreditsError(remaining);
}

export interface DebitResult {
  charged: number;
  remaining: number;
  wentNegative: boolean;
}

/**
 * Deduct credits atomically. Drains plan_credits first, then topup_credits
 * (which may go negative). Safe under concurrency — a single UPDATE ... RETURNING
 * so two parallel requests can't both read-then-write a stale balance.
 * Pass an existing client to run inside a caller's transaction.
 */
export async function debit(
  userId: number,
  credits: number,
  client?: PoolClient
): Promise<DebitResult> {
  const db = client ?? pool;
  const { rows } = await db.query(
    `UPDATE credit_balances
        SET plan_credits  = GREATEST(plan_credits - $2, 0),
            topup_credits = topup_credits - GREATEST($2 - plan_credits, 0),
            updated_at    = NOW()
      WHERE user_id = $1
      RETURNING plan_credits, topup_credits`,
    [userId, credits]
  );
  if (rows.length === 0) {
    // No wallet row (e.g. user predates the cutover). Nothing was debited, so
    // report it honestly — there's no negative balance to lock an output against.
    // (requireCredits already 402s a user with no positive balance under
    // enforcement, so this is defense-in-depth.)
    return { charged: 0, remaining: 0, wentNegative: false };
  }
  const remaining = Number(rows[0].plan_credits) + Number(rows[0].topup_credits);
  return { charged: credits, remaining, wentNegative: remaining < 0 };
}

type GrantType = "signup_grant" | "monthly_reset" | "topup" | "refund";

/**
 * Add credits and record the transaction. `monthly_reset` SETS plan_credits to
 * the allowance (no rollover) and opens a new period; everything else ADDS to
 * topup_credits. Idempotent for top-ups via the unique index on payment id.
 */
export async function grant(opts: {
  userId: number;
  type: GrantType;
  credits: number;
  periodEnd?: Date | null;
  razorpayPaymentId?: string;
  razorpayOrderId?: string;
  amountInr?: number;
}): Promise<{ applied: boolean }> {
  const { userId, type, credits } = opts;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotency guard for purchases: a captured payment credits at most once.
    if (opts.razorpayPaymentId) {
      const dup = await client.query(
        `SELECT 1 FROM credit_transactions WHERE razorpay_payment_id = $1`,
        [opts.razorpayPaymentId]
      );
      if (dup.rows.length > 0) {
        await client.query("ROLLBACK");
        return { applied: false };
      }
    }

    if (type === "monthly_reset") {
      await client.query(
        `INSERT INTO credit_balances (user_id, plan_credits, topup_credits, period_start, period_end)
           VALUES ($1, $2, 0, NOW(), $3)
         ON CONFLICT (user_id) DO UPDATE SET
           plan_credits = $2,
           period_start = NOW(),
           period_end   = $3,
           updated_at   = NOW()`,
        [userId, credits, opts.periodEnd ?? null]
      );
    } else {
      await client.query(
        `INSERT INTO credit_balances (user_id, plan_credits, topup_credits)
           VALUES ($1, 0, $2)
         ON CONFLICT (user_id) DO UPDATE SET
           topup_credits = credit_balances.topup_credits + $2,
           updated_at    = NOW()`,
        [userId, credits]
      );
    }

    await client.query(
      `INSERT INTO credit_transactions
         (user_id, type, credits, razorpay_payment_id, razorpay_order_id, amount_inr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        type,
        credits,
        opts.razorpayPaymentId ?? null,
        opts.razorpayOrderId ?? null,
        opts.amountInr ?? null,
      ]
    );

    await client.query("COMMIT");
    return { applied: true };
  } catch (err) {
    await client.query("ROLLBACK");
    // Lost the race on a concurrent grant for the same payment (the verify route
    // and the payment.captured webhook both fire on a purchase). The unique index
    // on razorpay_payment_id guarantees only one wins; treat the loser as a no-op
    // rather than a 500 (which would make Razorpay retry the webhook forever).
    if ((err as { code?: string }).code === "23505") return { applied: false };
    throw err;
  } finally {
    client.release();
  }
}

/** One-time free allowance for a brand-new user (no-op if already granted). */
export async function grantSignupCredits(userId: number): Promise<void> {
  const existing = await pool.query(
    `SELECT 1 FROM credit_transactions WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (existing.rows.length > 0) return;
  await grant({ userId, type: "signup_grant", credits: PLAN_CREDITS.freeLifetime });
}

/** Re-open any locked async outputs after a top-up restores a positive balance. */
export async function unlockOutputs(userId: number): Promise<void> {
  if ((await getRemaining(userId)) <= 0) return;
  await pool.query(
    `UPDATE translation_jobs SET output_locked = FALSE, unlocked_at = NOW()
       WHERE user_id = $1 AND output_locked = TRUE`,
    [userId]
  );
  await pool.query(
    `UPDATE ocr_jobs SET output_locked = FALSE, unlocked_at = NOW()
       WHERE user_id = $1 AND output_locked = TRUE`,
    [userId]
  );
}
