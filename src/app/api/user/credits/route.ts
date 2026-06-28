import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getRequestUser } from "@/lib/auth";
import { getBalance } from "@/lib/billing/credits";
import { TOPUP_TIERS } from "@/lib/billing/cost";
import { logError } from "@/lib/error-logger";

/**
 * GET /api/user/credits — the credit meter for the header + top-up modal.
 * Returns the remaining balance, the plan/topup split, the current period end,
 * and the purchasable top-up tiers. Never exposes the underlying rupee cost.
 */
export async function GET(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const user = await getRequestUser({ uid: decoded.uid, email: decoded.email });
    const balance = await getBalance(user.id);
    return NextResponse.json({
      plan: user.plan,
      remaining: balance.remaining,
      planCredits: balance.planCredits,
      topupCredits: balance.topupCredits,
      periodEnd: balance.periodEnd,
      lowBalance: balance.remaining <= 0,
      tiers: TOPUP_TIERS.map((t) => ({
        id: t.id,
        credits: t.credits,
        priceInr: t.priceInr,
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
