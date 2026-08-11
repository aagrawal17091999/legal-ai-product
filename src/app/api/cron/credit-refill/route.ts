import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import { grant } from "@/lib/billing/credits";
import { PLAN_CREDITS, addOneMonth } from "@/lib/billing/cost";
import { logError } from "@/lib/error-logger";

/**
 * Monthly credit refill for subscribers whose billing cycle is longer than their
 * credit period — i.e. the YEARLY plan.
 *
 * Why this exists: the Pro allowance is per MONTH, but credits were only granted
 * when Razorpay fired `subscription.charged`, which for a yearly plan happens
 * once a YEAR. A yearly subscriber therefore received 1,000 credits for twelve
 * months while a monthly subscriber on the same per-month price received 12,000.
 * This job issues the eleven intra-year refills.
 *
 * Monthly subscribers are deliberately NOT handled here — their refill rides on
 * the real `subscription.charged` webhook, which is authoritative about whether
 * money actually arrived. Refilling them from a timer would hand out free
 * credits on a failed renewal.
 *
 * Scheduling: daily is plenty (a period boundary only moves once a month).
 *   ENV_FILE=.env.production.local scripts/cron-tick.sh /api/cron/credit-refill
 *
 * Idempotency: each refill is keyed on the period boundary it opens, so running
 * this hourly, twice, or after a missed day all converge to exactly one grant
 * per month. Periods advance from the PREVIOUS period_end rather than from
 * `now`, so a late run doesn't push the anniversary later and drift.
 */

export const dynamic = "force-dynamic";

interface DueRow {
  user_id: number;
  razorpay_subscription_id: string | null;
  period_end: string | null;
  subscription_end_date: string | null;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logError({
      category: "payment",
      message: "CRON_SECRET not set — credit refill refusing to run",
      severity: "critical",
      endpoint: "/api/cron/credit-refill",
    });
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  if (request.headers.get("Authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Yearly subscribers, still active and still inside the year they paid for,
    // whose credit window has lapsed. `period_end IS NULL` covers a wallet that
    // predates the period columns — treat it as due so nobody is stranded.
    const { rows } = await pool.query<DueRow>(
      `SELECT u.id AS user_id,
              u.razorpay_subscription_id,
              b.period_end,
              u.subscription_end_date
         FROM users u
         JOIN credit_balances b ON b.user_id = u.id
        WHERE u.plan = 'yearly'
          AND u.subscription_status = 'active'
          AND (u.subscription_end_date IS NULL OR u.subscription_end_date > NOW())
          AND (b.period_end IS NULL OR b.period_end <= NOW())`
    );

    let refilled = 0;
    let skipped = 0;

    for (const row of rows) {
      // Advance from the lapsed boundary, not from now, so periods stay on their
      // original anniversary instead of sliding later every time this runs late.
      // Catch up if several boundaries were missed (box down for a while), but
      // never issue a period that starts in the future.
      const previousEnd = row.period_end ? new Date(row.period_end) : new Date();
      let nextEnd = addOneMonth(previousEnd);
      while (nextEnd <= new Date()) nextEnd = addOneMonth(nextEnd);

      // Never run the credit window past the subscription the user paid for.
      const subEnd = row.subscription_end_date ? new Date(row.subscription_end_date) : null;
      if (subEnd && nextEnd > subEnd) nextEnd = subEnd;

      // Key on the boundary this refill opens: stable across retries, distinct
      // per month. Falls back to the user id when a subscription id is missing.
      const key = `subrefill:${row.razorpay_subscription_id ?? `user${row.user_id}`}:${nextEnd
        .toISOString()
        .slice(0, 10)}`;

      const { applied } = await grant({
        userId: row.user_id,
        type: "monthly_reset",
        credits: PLAN_CREDITS.yearly,
        periodEnd: nextEnd,
        idempotencyKey: key,
      });
      if (applied) refilled++;
      else skipped++;
    }

    return NextResponse.json({ status: "ok", due: rows.length, refilled, skipped });
  } catch (err) {
    logError({
      category: "payment",
      message: `Credit refill failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "critical",
      endpoint: "/api/cron/credit-refill",
    });
    return NextResponse.json({ error: "Refill failed" }, { status: 500 });
  }
}
