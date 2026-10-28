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
/**
 * A RELATIVE Location, as proxy.ts sends: behind nginx, request.url is the
 * app's own address (localhost:3000), so an absolute URL built from it sends
 * the visitor to localhost. Browsers resolve a relative one against the page.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  // Program switched off: the link still lands somewhere useful, but carries
  // nothing — no code in the URL, no cookie.
  if (!REFERRALS_ENABLED) return redirectTo("/signup");

  const { code: raw } = await params;
  const code = normalizeReferralCode(raw);
  if (!code) return redirectTo("/signup");

  const res = redirectTo(`/signup?ref=${encodeURIComponent(code)}`);
  res.cookies.set(REFERRAL_COOKIE, code, {
    path: "/",
    maxAge: REFERRAL_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
  return res;
}
