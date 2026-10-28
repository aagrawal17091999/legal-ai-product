import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/admin";
import pool from "@/lib/db";
import { logError } from "@/lib/error-logger";
import { REFERRALS_ENABLED } from "@/lib/referrals/shared";

/**
 * GET /api/admin/referrals — program overview for /admin/referrals: totals and
 * recent rewards paid.
 * Works whether or not the program is switched on, so staff can test.
 */
export async function GET(request: NextRequest) {
  const gate = await requireStaff(request);
  if (gate.error) return gate.error;

  try {
    const [rewards, totals] = await Promise.all([
      pool.query(
        `SELECT r.id, r.referrer_user_id AS user_id, u.email, r.milestone, r.status,
                r.credits, r.applied_at
           FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id
          ORDER BY r.earned_at DESC
          LIMIT 200`
      ),
      pool.query<Record<string, string>>(
        `SELECT COUNT(*)                                        AS referrals,
                COUNT(*) FILTER (WHERE status = 'qualified')    AS qualified,
                COUNT(*) FILTER (WHERE status = 'disqualified') AS disqualified,
                (SELECT COUNT(*) FROM referral_rewards WHERE status = 'applied') AS rewards,
                (SELECT COALESCE(SUM(credits), 0) FROM referral_rewards
                  WHERE status = 'applied')                     AS credits
           FROM referrals`
      ),
    ]);

    return NextResponse.json({
      enabled: REFERRALS_ENABLED,
      rewards: rewards.rows,
      totals: Object.fromEntries(Object.entries(totals.rows[0]).map(([k, v]) => [k, Number(v)])),
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
