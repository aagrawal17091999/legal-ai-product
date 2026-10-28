/**
 * Turning a banked free month into a skipped renewal.
 *
 * The cron (/api/cron/referrals) and the staff buttons (/api/admin/referral-
 * rewards/[id]) call the SAME functions here, so the hand-run and automated
 * paths can't drift. REFERRAL_REWARDS_AUTO=on is the only difference: with it
 * off the cron still does the database-only work (qualifying referrals, banking
 * months, granting a free month's credits) and lists what is due, but never
 * calls Razorpay — staff apply each month from the admin queue.
 *
 * Two methods:
 *
 *   pause (default) — pause the subscription shortly before the renewal it
 *     replaces, resume it shortly before the next one. Razorpay must enable
 *     pause/resume on the account. It works for UPI Autopay, which plan/offer
 *     updates do not. While paused the user stays plan=<plan>, status=active
 *     in OUR table (subscription_end_date pushed to cycle_end), and their credits
 *     come from here (monthly) or /api/cron/credit-refill (yearly) because no
 *     subscription.charged arrives for the skipped cycle.
 *
 *   refund (REFERRAL_REWARD_METHOD=refund) — let the renewal charge, then
 *     refund it in full from the subscription.charged webhook. Always works, but
 *     the customer sees a debit and a refund, and the gateway fee is lost.
 *     Monthly only: refunding a yearly charge for one free month is wrong, so
 *     yearly always pauses (that is what "push the renewal back" means).
 *
 * Resume timing: Razorpay only offers resume_at "now", and its docs don't say
 * whether resume charges at once or waits for the original date. Resuming
 * REFERRAL_RESUME_LEAD_HOURS (default 24) before cycle_end is right for the
 * "waits" case; if a test-mode run shows resume charges immediately, set the
 * lead to 0 and run the cron hourly so the charge lands within the hour.
 */
import pool from "@/lib/db";
import {
  fetchSubscription,
  pauseSubscription,
  resumeSubscription,
  refundPayment,
} from "@/lib/razorpay";
import { grant } from "@/lib/billing/credits";
import { PLAN_CREDITS, addOneMonth } from "@/lib/billing/cost";
import { logError } from "@/lib/error-logger";
import { track } from "@/lib/analytics/server";
import { EVENTS } from "@/lib/analytics/events";

const HOUR_MS = 3600 * 1000;
/** Book a month this close to the renewal it replaces. */
const APPLY_LEAD_MS = 72 * HOUR_MS;

export function rewardsAutomationOn(): boolean {
  return process.env.REFERRAL_REWARDS_AUTO === "on";
}

function configuredMethod(): "pause" | "refund" {
  return process.env.REFERRAL_REWARD_METHOD === "refund" ? "refund" : "pause";
}

function resumeLeadMs(): number {
  const hours = Number(process.env.REFERRAL_RESUME_LEAD_HOURS);
  return (Number.isFinite(hours) && hours >= 0 ? hours : 24) * HOUR_MS;
}

/** A refusal staff can act on — the admin route maps it to a 400. */
export class RewardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewardError";
  }
}

interface RewardRow {
  id: number;
  referrer_user_id: number;
  milestone: number;
  status: "banked" | "scheduled" | "applied" | "revoked";
  method: "pause" | "refund" | "manual" | null;
  razorpay_subscription_id: string | null;
  cycle_start: Date | null;
  cycle_end: Date | null;
}

async function loadReward(id: number): Promise<RewardRow> {
  const { rows } = await pool.query<RewardRow>(
    `SELECT id, referrer_user_id, milestone, status, method, razorpay_subscription_id,
            cycle_start, cycle_end
       FROM referral_rewards WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new RewardError("No such reward");
  return rows[0];
}

async function loadSubscriber(userId: number) {
  const { rows } = await pool.query<{
    plan: "free" | "monthly" | "yearly";
    subscription_status: string;
    razorpay_subscription_id: string | null;
    comped_plan: boolean;
  }>(
    `SELECT plan, subscription_status, razorpay_subscription_id, comped_plan
       FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] ?? null;
}

/**
 * Book a banked month against the referrer's next renewal.
 *
 * `force` (staff) skips the "only within 3 days of the renewal" wait. Pausing
 * early is safe: access is governed by our own table, which still says active.
 */
export async function scheduleReward(
  rewardId: number,
  opts: { actor: string; force?: boolean }
): Promise<
  | { status: "not_due"; renewsAt: Date }
  | { status: "scheduled"; method: "pause" | "refund"; cycleStart: Date; cycleEnd: Date }
> {
  const reward = await loadReward(rewardId);
  if (reward.status !== "banked") {
    throw new RewardError(`This month is already ${reward.status}`);
  }
  const user = await loadSubscriber(reward.referrer_user_id);
  if (
    !user ||
    user.plan === "free" ||
    user.comped_plan ||
    !user.razorpay_subscription_id ||
    user.subscription_status !== "active"
  ) {
    throw new RewardError(
      "This user has no active Razorpay subscription, so there is no renewal to skip. The month stays banked until they have one."
    );
  }
  const subscriptionId = user.razorpay_subscription_id;
  const method = user.plan === "yearly" ? "pause" : configuredMethod();

  const sub = await fetchSubscription(subscriptionId);
  if (sub.status !== "active") {
    throw new RewardError(`Razorpay reports the subscription as "${sub.status}", not active`);
  }
  const chargeAt = Number(sub.charge_at ?? sub.current_end);
  if (!chargeAt) throw new RewardError("Razorpay returned no upcoming charge date");

  const cycleStart = new Date(chargeAt * 1000);
  if (!opts.force && cycleStart.getTime() - Date.now() > APPLY_LEAD_MS) {
    return { status: "not_due", renewsAt: cycleStart };
  }
  const cycleEnd = addOneMonth(cycleStart);

  // Claim the row BEFORE touching Razorpay, so the cron and a staff click can't
  // both pause. The partial unique index allows one scheduled month per user.
  try {
    const claimed = await pool.query(
      `UPDATE referral_rewards
          SET status = 'scheduled', method = $2, razorpay_subscription_id = $3,
              cycle_start = $4, cycle_end = $5, actor = $6,
              scheduled_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'banked'`,
      [reward.id, method, subscriptionId, cycleStart, cycleEnd, opts.actor]
    );
    if ((claimed.rowCount ?? 0) === 0) {
      throw new RewardError("This reward changed while you were looking at it. Refresh and retry.");
    }
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new RewardError("A free month is already in progress for this user");
    }
    throw err;
  }

  if (method === "pause") {
    try {
      await pauseSubscription(subscriptionId);
    } catch (err) {
      await pool.query(
        `UPDATE referral_rewards
            SET status = 'banked', method = NULL, razorpay_subscription_id = NULL,
                cycle_start = NULL, cycle_end = NULL, scheduled_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [reward.id]
      );
      throw err;
    }
    // Keeps the user on their plan through the free month. The renewal that
    // ends it comes back through subscription.charged, which overwrites this
    // with Razorpay's own current_end.
    await pool.query(
      `UPDATE users SET subscription_end_date = $2, updated_at = NOW() WHERE id = $1`,
      [reward.referrer_user_id, cycleEnd]
    );
  }

  track(EVENTS.REFERRAL_REWARD_SCHEDULED, {
    userId: reward.referrer_user_id,
    insertId: `ref_sched:${reward.id}`,
    properties: {
      reward_id: reward.id,
      milestone: reward.milestone,
      method,
      actor: opts.actor,
      cycle_start: cycleStart,
      cycle_end: cycleEnd,
      razorpay_subscription_id: subscriptionId,
    },
  });
  return { status: "scheduled", method, cycleStart, cycleEnd };
}

/**
 * The free month's credit allowance for a MONTHLY subscriber whose renewal was
 * skipped by a pause — normally subscription.charged grants it, and none comes.
 * Yearly users are refilled by /api/cron/credit-refill, which keeps running
 * because their subscription_end_date was pushed out. Idempotent per reward.
 */
async function grantFreeMonthCredits(reward: RewardRow): Promise<boolean> {
  if (reward.method !== "pause" || !reward.cycle_start || !reward.cycle_end) return false;
  if (reward.cycle_start.getTime() > Date.now()) return false;
  const user = await loadSubscriber(reward.referrer_user_id);
  if (user?.plan !== "monthly") return false;
  const { applied } = await grant({
    userId: reward.referrer_user_id,
    type: "monthly_reset",
    credits: PLAN_CREDITS.monthly,
    periodEnd: reward.cycle_end,
    idempotencyKey: `refreward:${reward.id}`,
  });
  if (applied) {
    track(EVENTS.CREDITS_REFILLED, {
      userId: reward.referrer_user_id,
      insertId: `refreward:${reward.id}`,
      properties: {
        plan: "monthly",
        credits: PLAN_CREDITS.monthly,
        period_end: reward.cycle_end,
        source: "referral_free_month",
        reward_id: reward.id,
      },
    });
  }
  return applied;
}

/** Database-only: grant every free month whose skipped renewal has arrived. */
export async function grantDueFreeMonthCredits(): Promise<number> {
  const { rows } = await pool.query<RewardRow>(
    `SELECT id, referrer_user_id, milestone, status, method, razorpay_subscription_id,
            cycle_start, cycle_end
       FROM referral_rewards
      WHERE status = 'scheduled' AND method = 'pause' AND cycle_start <= NOW()`
  );
  let granted = 0;
  for (const r of rows) if (await grantFreeMonthCredits(r)) granted++;
  return granted;
}

/**
 * End a paused free month: chain straight into the next banked month if there
 * is one (the subscription simply stays paused), otherwise resume billing.
 *
 * Called before cycle_start (staff only), this is an UNDO: billing resumes in
 * time for the renewal and the month goes back to banked.
 */
export async function completeReward(
  rewardId: number,
  opts: { actor: string; force?: boolean }
): Promise<{ status: "not_due" | "chained" | "resumed" | "undone" }> {
  const reward = await loadReward(rewardId);
  if (reward.status !== "scheduled" || reward.method !== "pause") {
    throw new RewardError("Only a free month in progress by pause can be finished or undone");
  }
  const subscriptionId = reward.razorpay_subscription_id!;
  const cycleStart = reward.cycle_start!;
  const cycleEnd = reward.cycle_end!;

  if (!opts.force && Date.now() < cycleEnd.getTime() - resumeLeadMs()) {
    return { status: "not_due" };
  }

  if (Date.now() < cycleStart.getTime()) {
    await resumeOrConfirm(subscriptionId);
    await pool.query(
      `UPDATE referral_rewards
          SET status = 'banked', method = NULL, razorpay_subscription_id = NULL,
              cycle_start = NULL, cycle_end = NULL, scheduled_at = NULL,
              note = 'undone by ' || $2, updated_at = NOW()
        WHERE id = $1 AND status = 'scheduled'`,
      [reward.id, opts.actor]
    );
    await pool.query(
      `UPDATE users SET subscription_end_date = $2, updated_at = NOW() WHERE id = $1`,
      [reward.referrer_user_id, cycleStart]
    );
    return { status: "undone" };
  }

  // Never finish a month without having given its credits.
  await grantFreeMonthCredits(reward);

  const user = await loadSubscriber(reward.referrer_user_id);
  const stillSubscribed =
    user?.subscription_status === "active" && user.razorpay_subscription_id === subscriptionId;
  const { rows: nextRows } = await pool.query<{ id: number; milestone: number }>(
    `SELECT id, milestone FROM referral_rewards
      WHERE referrer_user_id = $1 AND status = 'banked'
      ORDER BY milestone LIMIT 1`,
    [reward.referrer_user_id]
  );
  const next = stillSubscribed ? nextRows[0] : undefined;

  if (next) {
    const nextEnd = addOneMonth(cycleEnd);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE referral_rewards SET status = 'applied', applied_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [reward.id]
      );
      await client.query(
        `UPDATE referral_rewards
            SET status = 'scheduled', method = 'pause', razorpay_subscription_id = $2,
                cycle_start = $3, cycle_end = $4, actor = $5,
                scheduled_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'banked'`,
        [next.id, subscriptionId, cycleEnd, nextEnd, opts.actor]
      );
      await client.query(
        `UPDATE users SET subscription_end_date = $2, updated_at = NOW() WHERE id = $1`,
        [reward.referrer_user_id, nextEnd]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    trackApplied(reward, opts.actor, "chained");
    track(EVENTS.REFERRAL_REWARD_SCHEDULED, {
      userId: reward.referrer_user_id,
      insertId: `ref_sched:${next.id}`,
      properties: {
        reward_id: next.id,
        milestone: next.milestone,
        method: "pause",
        actor: opts.actor,
        cycle_start: cycleEnd,
        cycle_end: nextEnd,
        razorpay_subscription_id: subscriptionId,
        chained_from: reward.id,
      },
    });
    return { status: "chained" };
  }

  await resumeOrConfirm(subscriptionId);
  await pool.query(
    `UPDATE referral_rewards SET status = 'applied', applied_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'scheduled'`,
    [reward.id]
  );
  trackApplied(reward, opts.actor, "resumed");
  return { status: "resumed" };
}

/**
 * Resume, tolerating a subscription that no longer needs it — the customer
 * resumed it from their UPI app, or cancelled it while paused. Anything else
 * (still paused, unknown) is a real failure and is rethrown.
 */
async function resumeOrConfirm(subscriptionId: string): Promise<void> {
  try {
    await resumeSubscription(subscriptionId);
  } catch (err) {
    const sub = await fetchSubscription(subscriptionId).catch(() => null);
    if (sub && ["active", "cancelled", "completed", "expired"].includes(String(sub.status))) {
      return;
    }
    throw err;
  }
}

function trackApplied(reward: RewardRow, actor: string, outcome: string) {
  track(EVENTS.REFERRAL_REWARD_APPLIED, {
    userId: reward.referrer_user_id,
    insertId: `ref_applied:${reward.id}`,
    properties: {
      reward_id: reward.id,
      milestone: reward.milestone,
      method: reward.method,
      actor,
      outcome,
      cycle_start: reward.cycle_start,
      cycle_end: reward.cycle_end,
    },
  });
}

/**
 * Refund-method months: called from subscription.charged. If a refund month is
 * booked against this renewal, refund the charge in full and mark it applied.
 * The claim (scheduled -> applied) happens first so a retried webhook delivery
 * can't refund twice; a failed refund puts it back and rethrows, so Razorpay's
 * retry tries again.
 */
export async function refundBookedRenewal(opts: {
  userId: number;
  subscriptionId: string;
  paymentId: string;
}): Promise<boolean> {
  const { rows } = await pool.query<RewardRow>(
    `UPDATE referral_rewards
        SET status = 'applied', applied_at = NOW(), updated_at = NOW()
      WHERE id = (
              SELECT id FROM referral_rewards
               WHERE referrer_user_id = $1 AND status = 'scheduled' AND method = 'refund'
                 AND razorpay_subscription_id = $2
                 AND cycle_start <= NOW() + interval '3 days'
               LIMIT 1)
      RETURNING id, referrer_user_id, milestone, status, method, razorpay_subscription_id,
                cycle_start, cycle_end`,
    [opts.userId, opts.subscriptionId]
  );
  const reward = rows[0];
  if (!reward) return false;

  try {
    const refund = await refundPayment(opts.paymentId, {
      notes: { kind: "referral_free_month", reward_id: String(reward.id) },
    });
    await pool.query(`UPDATE referral_rewards SET refund_id = $2 WHERE id = $1`, [
      reward.id,
      refund.id,
    ]);
  } catch (err) {
    await pool.query(
      `UPDATE referral_rewards SET status = 'scheduled', applied_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [reward.id]
    );
    throw err;
  }
  trackApplied(reward, "webhook", "refunded");
  return true;
}

/**
 * True while a free month is running on a pause. Cancelling then has to end the
 * subscription immediately: there is no paid period left to run out, and a
 * cycle-end cancel on a paused subscription would leave it paused indefinitely.
 */
export async function freeMonthInProgress(userId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM referral_rewards
      WHERE referrer_user_id = $1 AND status = 'scheduled' AND method = 'pause'`,
    [userId]
  );
  return rows.length > 0;
}

/**
 * Cancelling forfeits every free month not yet used — banked ones and the one
 * in progress. Product rule: "if they cancel, it's all gone". Their qualified
 * referrals still stand; months earned from future referrals count afresh if
 * they subscribe again. Idempotent; returns how many months were forfeited.
 */
export async function forfeitRewards(userId: number, reason: string): Promise<number> {
  const { rows } = await pool.query<{ id: number; milestone: number }>(
    `UPDATE referral_rewards
        SET status = 'forfeited', note = $2, updated_at = NOW()
      WHERE referrer_user_id = $1 AND status IN ('banked', 'scheduled')
      RETURNING id, milestone`,
    [userId, reason]
  );
  for (const r of rows) {
    track(EVENTS.REFERRAL_REWARD_FORFEITED, {
      userId,
      insertId: `ref_forfeit:${r.id}`,
      properties: { reward_id: r.id, milestone: r.milestone, reason },
    });
  }
  return rows.length;
}

export interface DueReward {
  reward_id: number;
  user_id: number;
  email: string;
  plan: string;
  milestone: number;
  /** schedule: the renewal it would replace (our copy); complete: cycle_end. */
  due_at: string | null;
}

/**
 * What needs doing now. `toSchedule` is the earliest banked month of each
 * subscriber whose renewal is within 3 days and who has nothing in progress
 * (our subscription_end_date is the renewal; scheduleReward re-reads the real
 * date from Razorpay). `toComplete` is every paused month whose resume time
 * has arrived.
 */
export async function findDueRewardWork(): Promise<{
  toSchedule: DueReward[];
  toComplete: DueReward[];
}> {
  const [schedule, complete] = await Promise.all([
    pool.query<DueReward>(
      `SELECT DISTINCT ON (r.referrer_user_id)
              r.id AS reward_id, r.referrer_user_id AS user_id, u.email, u.plan,
              r.milestone, u.subscription_end_date AS due_at
         FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id
        WHERE r.status = 'banked'
          AND u.plan IN ('monthly', 'yearly')
          AND u.subscription_status = 'active'
          AND NOT u.comped_plan
          AND u.razorpay_subscription_id IS NOT NULL
          AND u.subscription_end_date <= NOW() + interval '72 hours'
          AND NOT EXISTS (SELECT 1 FROM referral_rewards s
                           WHERE s.referrer_user_id = r.referrer_user_id
                             AND s.status = 'scheduled')
        ORDER BY r.referrer_user_id, r.milestone`
    ),
    pool.query<DueReward>(
      `SELECT r.id AS reward_id, r.referrer_user_id AS user_id, u.email, u.plan,
              r.milestone, r.cycle_end AS due_at
         FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id
        WHERE r.status = 'scheduled' AND r.method = 'pause'
          AND r.cycle_end <= NOW() + ($1 || ' milliseconds')::interval
        ORDER BY r.cycle_end`,
      [String(resumeLeadMs())]
    ),
  ]);
  return { toSchedule: schedule.rows, toComplete: complete.rows };
}

/** The cron's Razorpay half. Each item fails on its own; one bad row never blocks the rest. */
export async function runDueRewardWork(work: {
  toSchedule: DueReward[];
  toComplete: DueReward[];
}): Promise<{ scheduled: number; completed: number; failed: number }> {
  let scheduled = 0;
  let completed = 0;
  let failed = 0;

  // Finish before starting, so a month ending today frees the one-in-progress
  // slot for a chained month rather than racing it.
  for (const item of work.toComplete) {
    try {
      const r = await completeReward(item.reward_id, { actor: "cron" });
      if (r.status !== "not_due") completed++;
    } catch (err) {
      failed++;
      logRewardFailure("complete", item, err);
    }
  }
  for (const item of work.toSchedule) {
    try {
      const r = await scheduleReward(item.reward_id, { actor: "cron" });
      if (r.status === "scheduled") scheduled++;
    } catch (err) {
      failed++;
      logRewardFailure("schedule", item, err);
    }
  }
  return { scheduled, completed, failed };
}

function logRewardFailure(step: string, item: DueReward, err: unknown) {
  logError({
    category: "payment",
    message: `Referral reward ${step} failed for reward ${item.reward_id}: ${
      err instanceof Error ? err.message : String(err)
    }`,
    error: err,
    // A failed resume means a customer is getting months free that they
    // didn't earn — that one needs a human today.
    severity: step === "complete" ? "critical" : "error",
    userId: item.user_id,
    endpoint: "/api/cron/referrals",
    metadata: { rewardId: item.reward_id, step },
  });
}
