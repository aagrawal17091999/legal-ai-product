import { NextRequest, NextResponse } from "next/server";
import { verifyAuth, getOrCreateUser, invalidateUserCache } from "@/lib/auth";
import { claimReferral } from "@/lib/referrals";
import { CLAIM_ERRORS } from "@/lib/referrals/shared";
import { logError } from "@/lib/error-logger";

/**
 * POST /api/referrals/claim { code } — attach a referral code to the caller's
 * new account. Sent by the onboarding step, from the code the /r/ link or the
 * signup form left in the referral cookie, or typed into the step itself.
 *
 * Refusals are 400s with a reason the client can show; the client clears its
 * cookie on any definite answer so a dead code isn't retried on every page load.
 */
export async function POST(request: NextRequest) {
  const decoded = await verifyAuth(request);
  if (!decoded) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const code = typeof body.code === "string" ? body.code : "";

  try {
    // getOrCreateUser, not the cached reader: this runs seconds after signup and
    // the eligibility checks need the row's real plan and created_at.
    const user = await getOrCreateUser({ uid: decoded.uid, email: decoded.email });
    const result = await claimReferral(user, code);
    if (!result.ok) {
      return NextResponse.json(
        { error: CLAIM_ERRORS[result.reason], reason: result.reason },
        { status: 400 }
      );
    }
    invalidateUserCache(decoded.uid);
    return NextResponse.json({ status: "ok", referrerName: result.referrerName });
  } catch (err) {
    logError({
      category: "database",
      message: err instanceof Error ? err.message : String(err),
      error: err,
      severity: "error",
      endpoint: "/api/referrals/claim",
      method: "POST",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
