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
 * True for accounts flagged as unlimited (migration 025). Such users are never
 * gated by requireCredits() and never debited by the meter, regardless of their
 * balance or BILLING_ENFORCE. A missing user row reads as not-unlimited.
 */
export async function isUnlimited(userId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT unlimited_credits FROM users WHERE id = $1`,
    [userId]
  );
  return rows.length > 0 && rows[0].unlimited_credits === true;
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
  if (await isUnlimited(userId)) return;
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

type GrantType =
  | "signup_grant"
  | "monthly_reset"
  | "topup"
  | "refund"
  /** Staff-issued credits (admin console). Lands in topup_credits like a purchase,
   *  but with amount_inr NULL so it never inflates revenue figures. */
  | "admin_grant"
  /** Staff claw-back of credits. Stored with a NEGATIVE `credits` value. */
  | "admin_revoke";

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
  /** Deterministic dedup key for non-payment grants (e.g. a per-cycle monthly
   *  reset). Stored in the razorpay_payment_id column, which carries a partial
   *  unique index, so repeated/out-of-order webhook deliveries for the same
   *  billing cycle apply the grant exactly once. */
  idempotencyKey?: string;
}): Promise<{ applied: boolean }> {
  const { userId, type, credits } = opts;
  // The razorpay_payment_id column doubles as the idempotency reference for
  // non-payment grants. A real payment id always wins if both are somehow set.
  const dedupKey = opts.razorpayPaymentId ?? opts.idempotencyKey;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotency guard: a captured payment — or a keyed grant such as a monthly
    // reset — applies at most once.
    if (dedupKey) {
      const dup = await client.query(
        `SELECT 1 FROM credit_transactions WHERE razorpay_payment_id = $1`,
        [dedupKey]
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
        dedupKey ?? null,
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

/**
 * Credit a user back for work that was charged but ultimately not delivered
 * (e.g. a multi-section job that metered successful sections, then failed as a
 * whole). Adds to topup_credits and records a `refund` ledger row. No-op for a
 * non-positive amount. Callers must invoke this at most once per failed unit
 * (terminal job transitions are CAS-guarded, so this is safe in practice).
 */
export async function refund(
  userId: number,
  credits: number,
  amountInr?: number
): Promise<{ applied: boolean }> {
  const rounded = Math.round(credits);
  if (rounded <= 0) return { applied: false };
  return grant({ userId, type: "refund", credits: rounded, amountInr });
}

/**
 * Staff adjustment of a user's wallet from the admin console.
 *
 * Adds to (or, for a negative amount, removes from) `topup_credits` — the
 * persistent bucket — so a grant survives the next billing-cycle reset, which is
 * what "give this user extra credits" means in every case we actually issue it
 * for (support gesture, comped trial, correcting a mis-metered job).
 *
 * A claw-back is clamped to the balance on hand: an admin typo must not push a
 * user into a negative wallet, which would silently block them AND withhold any
 * async outputs they had already paid for. The clamped figure is returned so the
 * caller can record what really happened rather than what was asked for.
 */
export async function adminAdjustCredits(opts: {
  userId: number;
  /** Positive to grant, negative to revoke. Rounded to a whole credit. */
  credits: number;
}): Promise<{ applied: number; remaining: number }> {
  const requested = Math.round(opts.credits);
  if (requested === 0) {
    return { applied: 0, remaining: await getRemaining(opts.userId) };
  }

  let applied = requested;
  if (requested < 0) {
    const remaining = await getRemaining(opts.userId);
    // Nothing left to take back.
    if (remaining <= 0) return { applied: 0, remaining };
    applied = -Math.min(-requested, remaining);
  }

  await grant({
    userId: opts.userId,
    type: applied > 0 ? "admin_grant" : "admin_revoke",
    credits: applied,
  });

  // A grant can lift a user out of a negative balance, which is exactly when
  // their finished-but-withheld jobs should be released.
  if (applied > 0) await unlockOutputs(opts.userId);

  return { applied, remaining: await getRemaining(opts.userId) };
}

/**
 * One-time free allowance for a brand-new user (no-op if already granted).
 *
 * The ledger pre-check alone is NOT enough: it is a check-then-act race, and
 * auth.ts calls this on every upsert. A first login that fans out into several
 * concurrent requests had every one of them read an empty ledger and then insert
 * its own grant — which is how users ended up with 200 and 300 free credits
 * instead of 100. The `signup:<id>` idempotency key puts the guard in the
 * database instead: it lands in razorpay_payment_id, which carries a partial
 * unique index, so concurrent callers race on an INSERT that only one can win
 * and grant() maps the losers' 23505 to a no-op.
 *
 * The pre-check stays because it also covers grants made before this key
 * existed, whose rows have a NULL key and so are invisible to the index.
 */
export async function grantSignupCredits(userId: number): Promise<void> {
  const existing = await pool.query(
    `SELECT 1 FROM credit_transactions WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (existing.rows.length > 0) return;
  await grant({
    userId,
    type: "signup_grant",
    credits: PLAN_CREDITS.freeLifetime,
    idempotencyKey: `signup:${userId}`,
  });
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
