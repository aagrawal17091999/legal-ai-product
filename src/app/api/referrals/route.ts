import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser } from "@/lib/auth";
import { getReferralSummary } from "@/lib/referrals";
import { logError } from "@/lib/error-logger";
import { REFERRALS_ENABLED } from "@/lib/referrals/shared";

/**
 * GET /api/referrals — the caller's own referral link, progress toward the next
 * reward, and the people they've referred (names shortened, emails masked).
 * Allocates their code on first call.
 */
export async function GET(request: NextRequest) {
  if (!REFERRALS_ENABLED) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const user = await getOrCreateUser({ uid: decoded.uid, email: decoded.email });
    return NextResponse.json(await getReferralSummary(user));
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/referrals",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
