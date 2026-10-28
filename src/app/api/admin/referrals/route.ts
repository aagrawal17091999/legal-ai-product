import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/admin";
import pool from "@/lib/db";
import { findDueRewardWork, rewardsAutomationOn } from "@/lib/referrals/rewards";
import { logError } from "@/lib/error-logger";

/**
 * GET /api/admin/referrals — the free-month queue behind /admin/referrals.
 *
 * `due` is exactly what the cron would act on right now (the same query), so
 * with REFERRAL_REWARDS_AUTO off this is the hand-run to-do list, and with it
 * on, anything that lingers here means the cron is failing on it.
 */
export async function GET(request: NextRequest) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  try {
    const [due, rewards, pending, totals] = await Promise.all([
      findDueRewardWork(),
      pool.query(
        `SELECT r.id, r.referrer_user_id AS user_id, u.email, u.plan, u.subscription_status,
                u.subscription_end_date, r.milestone, r.status, r.method,
                r.cycle_start, r.cycle_end, r.refund_id, r.actor, r.note,
                r.earned_at, r.applied_at
           FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id
          WHERE r.status IN ('banked', 'scheduled')
             OR r.updated_at > NOW() - interval '60 days'
          ORDER BY CASE r.status WHEN 'scheduled' THEN 0 WHEN 'banked' THEN 1 ELSE 2 END,
                   r.updated_at DESC
          LIMIT 200`
      ),
      pool.query(
        `SELECT r.id, r.referrer_user_id, ru.email AS referrer_email,
                r.referee_user_id, eu.email AS referee_email, r.first_paid_at, r.qualifies_at
           FROM referrals r
           JOIN users ru ON ru.id = r.referrer_user_id
           JOIN users eu ON eu.id = r.referee_user_id
          WHERE r.status = 'pending'
          ORDER BY r.qualifies_at
          LIMIT 200`
      ),
      pool.query<Record<string, string>>(
        `SELECT COUNT(*)                                        AS referrals,
                COUNT(*) FILTER (WHERE status = 'pending')      AS pending,
                COUNT(*) FILTER (WHERE status = 'qualified')    AS qualified,
                COUNT(*) FILTER (WHERE status = 'disqualified') AS disqualified,
                (SELECT COUNT(*) FROM referral_rewards WHERE status <> 'revoked') AS months_earned,
                (SELECT COUNT(*) FROM referral_rewards WHERE status = 'applied')  AS months_applied
           FROM referrals`
      ),
    ]);

    const t = totals.rows[0];
    return NextResponse.json({
      auto: rewardsAutomationOn(),
      method: process.env.REFERRAL_REWARD_METHOD === "refund" ? "refund" : "pause",
      due,
      rewards: rewards.rows,
      pending: pending.rows,
      totals: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Number(v)])),
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      userId: gate.user.id,
      endpoint: "/api/admin/referrals",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
