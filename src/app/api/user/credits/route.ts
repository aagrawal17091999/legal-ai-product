import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { getBalance, isUnlimited } from "@/lib/billing/credits";
import { TOPUP_TIERS, GST_RATE, withGst } from "@/lib/billing/cost";
import { logError } from "@/lib/error-logger";

/**
 * GET /api/user/credits — the credit meter for the header + top-up modal.
 * Returns the remaining balance, the plan/topup split, the current period end,
 * and the purchasable top-up tiers. Never exposes the underlying rupee cost.
 */

/** Show the "running low" warning at or below this many credits. */
const LOW_BALANCE_THRESHOLD = 100;

export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const [balance, unlimited] = await Promise.all([
      getBalance(user.id),
      isUnlimited(user.id),
    ]);
    return NextResponse.json({
      plan: user.plan,
      unlimited,
      remaining: balance.remaining,
      planCredits: balance.planCredits,
      topupCredits: balance.topupCredits,
      periodEnd: balance.periodEnd,
      // `lowBalance` warns BEFORE the wall; `exhausted` is the wall itself. They
      // were the same field, which meant the only warning a user ever got was
      // the 402 that had already blocked them.
      lowBalance: !unlimited && balance.remaining <= LOW_BALANCE_THRESHOLD,
      exhausted: !unlimited && balance.remaining <= 0,
      gstRate: GST_RATE,
      tiers: TOPUP_TIERS.map((t) => ({
        id: t.id,
        credits: t.credits,
        priceInr: t.priceInr, // ex-GST, as listed
        totalInr: withGst(t.priceInr), // what the card is actually charged
        perCredit: t.perCredit,
      })),
    });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/user/credits",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
