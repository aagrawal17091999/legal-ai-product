import { NextRequest, NextResponse } from "next/server";
import { findReferrerByCode, publicName } from "@/lib/referrals";
import { logError } from "@/lib/error-logger";
import { REFERRALS_ENABLED } from "@/lib/referrals/shared";

/**
 * GET /api/referrals/lookup?code=PRIYA7K — public (the visitor has no account
 * yet). Says whether a code exists and whose it is, for the signup banner.
 * Returns only "Priya S.": a code is shared freely, so it must not unlock an
 * email address or phone number.
 */
export async function GET(request: NextRequest) {
  if (!REFERRALS_ENABLED) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const code = request.nextUrl.searchParams.get("code") ?? "";
  try {
    const referrer = await findReferrerByCode(code);
    if (!referrer) return NextResponse.json({ valid: false });
    return NextResponse.json({ valid: true, referrerName: publicName(referrer.display_name) });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/referrals/lookup",
      method: "GET",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
