import { NextRequest, NextResponse } from "next/server";
import {
  REFERRALS_ENABLED,
  REFERRAL_COOKIE,
  REFERRAL_COOKIE_MAX_AGE,
  normalizeReferralCode,
} from "@/lib/referrals/shared";

/**
 * GET /r/<code> — the shareable referral link.
 *
 * Remembers the code in a cookie for 30 days and sends the visitor to signup
 * with it pre-filled. The cookie is what makes attribution survive a detour
 * (reading the landing page first, signing in with Google from /login): the
 * claim itself happens after the account exists, from the onboarding step.
 * Not httpOnly on purpose — the signup page reads it to show the field.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const target = new URL("/signup", request.url);
  // Program switched off: the link still lands somewhere useful, but carries
  // nothing — no code in the URL, no cookie.
  if (!REFERRALS_ENABLED) return NextResponse.redirect(target);

  const { code: raw } = await params;
  const code = normalizeReferralCode(raw);
  if (code) target.searchParams.set("ref", code);

  const res = NextResponse.redirect(target);
  if (code) {
    res.cookies.set(REFERRAL_COOKIE, code, {
      path: "/",
      maxAge: REFERRAL_COOKIE_MAX_AGE,
      sameSite: "lax",
    });
  }
  return res;
}
