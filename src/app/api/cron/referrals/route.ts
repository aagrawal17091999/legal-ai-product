import { NextRequest, NextResponse } from "next/server";
import { qualifyDueReferrals } from "@/lib/referrals";
import {
  findDueRewardWork,
  grantDueFreeMonthCredits,
  rewardsAutomationOn,
  runDueRewardWork,
} from "@/lib/referrals/rewards";
import { logError } from "@/lib/error-logger";

/**
 * Referral program tick. Hourly (deploy/systemd/nyayasearch-referrals.timer).
 *
 * Always, database-only:
 *   1. settle pending referrals whose 7-day window has passed, banking a free
 *      month for every 5 qualified;
 *   2. grant the credits for any free month whose skipped renewal has arrived.
 * Only with REFERRAL_REWARDS_AUTO=on, calls Razorpay:
 *   3. finish free months that are ending (chain or resume), then book banked
 *      months against renewals due within 3 days (pause, or refund mode).
 * With it off, step 3 is reported as `due` and done by hand from /admin/referrals.
 *
 * Hourly rather than daily because resume timing matters: a pause still in
 * place when the next renewal falls due would skip a month nobody earned.
 * Every step is idempotent, so extra runs cost nothing.
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

  try {
    const qualification = await qualifyDueReferrals();
    const creditsGranted = await grantDueFreeMonthCredits();
    const due = await findDueRewardWork();
    const auto = rewardsAutomationOn();
    const automation = auto ? await runDueRewardWork(due) : null;

    return NextResponse.json({
      status: "ok",
      ...qualification,
      creditsGranted,
      auto,
      due: { schedule: due.toSchedule.length, complete: due.toComplete.length },
      ...(automation ?? {}),
    });
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
