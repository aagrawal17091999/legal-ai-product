/**
 * Shared by the onboarding modal and /api/user/onboarding, so the options the
 * user sees and the values the server accepts can't drift apart.
 */

export const REFERRAL_SOURCES = [
  { value: "friend", label: "Friend or colleague" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "google", label: "Google search" },
  { value: "whatsapp", label: "WhatsApp group" },
  { value: "bar_association", label: "Bar association or event" },
  { value: "other", label: "Other" },
] as const;

export type ReferralSource = (typeof REFERRAL_SOURCES)[number]["value"];

export function isReferralSource(v: unknown): v is ReferralSource {
  return REFERRAL_SOURCES.some((s) => s.value === v);
}

export const REFERRAL_DETAIL_MAX = 200;

/**
 * Normalise an Indian mobile number to +91XXXXXXXXXX, or null if it isn't one.
 * Accepts the ways people actually type it: spaces, dashes, a leading 0, +91 or
 * 91. Indian mobiles are 10 digits starting 6–9.
 */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+91")) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}
