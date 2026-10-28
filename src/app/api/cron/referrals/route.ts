import { NextRequest, NextResponse } from "next/server";
import { qualifyDueReferrals, settleBankedRewards } from "@/lib/referrals";
import { logError } from "@/lib/error-logger";
import { REFERRALS_ENABLED } from "@/lib/referrals/shared";

/**
 * Referral program tick. Hourly (deploy/systemd/nyayasearch-referrals.timer).
 *
 *   1. Settle pending referrals whose 7-day window has passed: qualified if the
 *      first payment still stands, disqualified if it was refunded. Every 5
 *      qualified pays the referrer 2,000 credits on the spot.
 *   2. Pay any reward an interrupted run left banked.
 *
 * Every step is idempotent, so extra or overlapping runs cost nothing. Hourly
 * only so a reward lands within the hour its window closes; daily would do.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logError({
      category: "payment",
      message: "CRON_SECRET not set — referral cron refusing to run",
      severity: "critical",
      endpoint: "/api/cron/referrals",
    });
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  if (request.headers.get("Authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Nothing can be claimed while the program is off, so there is nothing to do.
  if (!REFERRALS_ENABLED) return NextResponse.json({ status: "disabled" });

  try {
    const qualification = await qualifyDueReferrals();
    const resettled = await settleBankedRewards();
    return NextResponse.json({ status: "ok", ...qualification, resettled });
  } catch (err) {
    logError({
      category: "payment",
      message: `Referral cron failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
      severity: "critical",
      endpoint: "/api/cron/referrals",
    });
    return NextResponse.json({ error: "Referral cron failed" }, { status: 500 });
  }
}
