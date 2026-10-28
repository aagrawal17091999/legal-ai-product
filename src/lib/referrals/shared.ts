/**
 * Referral program constants and helpers that are safe in the browser. The
 * server-only logic (attribution, qualification, rewards) lives in ./index.ts.
 */
import { PLAN_CREDITS } from "@/lib/billing/cost";

/**
 * Master switch for everything a user can see or reach: the "Refer & earn"
 * card and sidebar link, the signup/onboarding code fields, /r/ links, the
 * user-facing /api/referrals routes, the terms clause, and the hourly cron.
 * Off unless NEXT_PUBLIC_REFERRALS_ENABLED=on. NEXT_PUBLIC so the same value is
 * inlined into the browser bundle — flipping it needs a rebuild, not a reload.
 * Staff pages (/admin/referrals) stay reachable either way, for testing.
 */
export const REFERRALS_ENABLED = process.env.NEXT_PUBLIC_REFERRALS_ENABLED === "on";

/** Qualified referrals per reward. */
export const REFERRALS_PER_REWARD = 5;

/**
 * Credits per reward: one month of the Pro allowance, added to the persistent
 * top-up pool so they never expire and survive plan resets and cancellation.
 */
export const REFERRAL_REWARD_CREDITS = PLAN_CREDITS.monthly;

/**
 * How long after signup a code can still be attached. Long enough for someone
 * who skipped the field to add it from the onboarding step on a later visit;
 * short enough that an established account can't be retro-fitted to a referrer.
 */
export const REFERRAL_CLAIM_WINDOW_DAYS = 7;

/** Carries a code from /r/<code> (or the signup field) through signup. */
export const REFERRAL_COOKIE = "lb_ref";
export const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** Uppercase letters and digits, 4–16 long. Anything else is not a code. */
export function normalizeReferralCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const code = input.trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : null;
}

export function readReferralCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${REFERRAL_COOKIE}=([^;]*)`));
  return match ? normalizeReferralCode(decodeURIComponent(match[1])) : null;
}

export function writeReferralCookie(code: string | null): void {
  if (typeof document === "undefined") return;
  document.cookie = code
    ? `${REFERRAL_COOKIE}=${encodeURIComponent(code)}; path=/; max-age=${REFERRAL_COOKIE_MAX_AGE}; samesite=lax`
    : `${REFERRAL_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** Why a claim was refused, in words a user can act on. */
export const CLAIM_ERRORS: Record<string, string> = {
  invalid_code: "That referral code doesn't exist. Check it and try again.",
  self: "You can't use your own referral code.",
  already_referred: "Your account already has a referral code attached.",
  too_late: `Referral codes can only be added within ${REFERRAL_CLAIM_WINDOW_DAYS} days of signing up.`,
  already_paying: "Referral codes can only be added before your first payment.",
};

export type ReferralStatus = "signed_up" | "qualified" | "disqualified";

/** GET /api/referrals — the referrer's own view. */
export interface ReferralSummary {
  code: string;
  link: string;
  perReward: number;
  creditsPerReward: number;
  counts: { signedUp: number; qualified: number };
  /** Qualified referrals toward the next reward (0..perReward-1). */
  progress: number;
  rewards: { earned: number; credits: number };
  referrals: {
    name: string;
    email: string;
    status: ReferralStatus;
    joinedAt: string;
    firstPaidAt: string | null;
  }[];
}
