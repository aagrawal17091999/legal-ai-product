import { NextRequest, NextResponse } from "next/server";
import { settleBankedRewards } from "@/lib/referrals";
import { logError } from "@/lib/error-logger";
import { REFERRALS_ENABLED } from "@/lib/referrals/shared";

/**
 * Referral program safety net. Hourly (deploy/systemd/nyayasearch-referrals.timer).
 *
 * Rewards are paid inside the payment webhook, the moment a 5th referral pays.
 * If that request dies between banking the reward and granting its credits,
 * the reward sits 'banked'; this pays it. Idempotent, so extra runs cost nothing.
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
    const resettled = await settleBankedRewards();
    return NextResponse.json({ status: "ok", resettled });
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
