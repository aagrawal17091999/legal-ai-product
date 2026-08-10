/**
 * Billing cost model — the single source of truth for turning token usage into
 * rupees and credits. Change a model price here and the whole metering system
 * follows. Nothing else in the app should hardcode a per-token rate.
 *
 *   1 credit = ₹CREDIT_INR of measured AI cost (COGS). Credits are the unit we
 *   show users; rupees are what we actually spend. We never surface the raw
 *   rupee figure to users — only credits.
 */

/** ₹ per USD. Override via env if the rate drifts materially. */
export const FX_INR_PER_USD = Number(process.env.BILLING_FX_INR_PER_USD) || 86;

/** Rupees of COGS represented by one credit. 1000 credits = ₹800 (Pro pool). */
export const CREDIT_INR = Number(process.env.BILLING_CREDIT_INR) || 0.8;

/** Plan + free allowances, in credits. */
export const PLAN_CREDITS = {
  monthly: 1000,
  yearly: 1000, // same monthly allowance; reset on each subscription.charged
  freeLifetime: 100,
} as const;

/**
 * USD per 1,000,000 tokens, per Anthropic / Voyage list pricing.
 * cacheRead ≈ 0.1× input, cacheWrite ≈ 1.25× input (5-min TTL).
 */
type Rate = { input: number; output?: number; cacheRead?: number; cacheWrite?: number };
const RATES: Record<string, Rate> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "voyage-law-2": { input: 0.12 },
  "rerank-2": { input: 0.05 },
};

/** Anthropic usage shape (subset we bill on). All fields optional/defaulted.
 *  Cache fields are nullable to match the SDK's `Usage` type (number | null);
 *  every consumer coalesces with `?? 0`. */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Normalize a possibly date-suffixed model id ("claude-haiku-4-5-20251001")
 * to a rate key ("claude-haiku-4-5"). Falls back to a longest-prefix match so a
 * future snapshot id still prices correctly instead of silently costing zero.
 */
export function rateKeyFor(model: string): string | null {
  if (RATES[model]) return model;
  let best: string | null = null;
  for (const key of Object.keys(RATES)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

/** Cost in INR of one Claude call from its usage block. Returns 0 if unknown. */
export function claudeCostInr(model: string, u: ClaudeUsage): number {
  const key = rateKeyFor(model);
  if (!key) return 0;
  const r = RATES[key];
  const perTok = (usd: number) => (usd / 1_000_000) * FX_INR_PER_USD;
  return (
    perTok(r.input) * (u.input_tokens ?? 0) +
    perTok(r.output ?? r.input) * (u.output_tokens ?? 0) +
    perTok(r.cacheRead ?? r.input) * (u.cache_read_input_tokens ?? 0) +
    perTok(r.cacheWrite ?? r.input) * (u.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Sarvam Doc AI is priced per PAGE, not per token — ₹0.50/page off their public
 * price list, already in rupees so no FX applies. Env-overridable so a rate
 * change doesn't need a deploy.
 */
export const SARVAM_INR_PER_PAGE = Number(process.env.BILLING_SARVAM_INR_PER_PAGE) || 0.5;

/**
 * Sarvam /translate (sarvam-translate:v1) is priced per CHARACTER — ₹20 per
 * 10,000 characters off their public price list. At ~2,300 chars/page that is
 * ~₹4.6/page, which makes translation, not reading, the dominant Sarvam cost.
 */
export const SARVAM_INR_PER_10K_CHARS =
  Number(process.env.BILLING_SARVAM_INR_PER_10K_CHARS) || 20;

/** The model-breakdown keys Sarvam usage is recorded under in usage_events. */
export const SARVAM_MODEL_KEY = "sarvam-doc-ai";
export const SARVAM_TRANSLATE_MODEL_KEY = "sarvam-translate";

/** Cost in INR of reading `pages` pages with Sarvam Doc AI. */
export function sarvamCostInr(pages: number): number {
  return SARVAM_INR_PER_PAGE * Math.max(0, pages ?? 0);
}

/** Cost in INR of translating `chars` characters with Sarvam /translate. */
export function sarvamTranslateCostInr(chars: number): number {
  return (SARVAM_INR_PER_10K_CHARS / 10_000) * Math.max(0, chars ?? 0);
}

/** Cost in INR of a Voyage embed/rerank call from its reported total tokens. */
export function voyageCostInr(model: string, totalTokens: number): number {
  const key = rateKeyFor(model);
  if (!key) return 0;
  return (RATES[key].input / 1_000_000) * FX_INR_PER_USD * (totalTokens ?? 0);
}

/** Convert measured rupee cost into the credits to debit (always round up). */
export function inrToCredits(costInr: number): number {
  return Math.ceil(costInr / CREDIT_INR);
}

/**
 * Top-up packs. Per-credit price decays as size grows (volume discount) but
 * never drops below ₹1.70/credit, keeping ≥50% gross margin on every tier
 * (cost basis is ₹0.80/credit). `id` is what the client sends to /credits/order.
 */
export interface TopupTier {
  id: string;
  credits: number;
  priceInr: number; // ex-GST; Razorpay adds GST per the plan config
  perCredit: number; // derived, for display
  marginPct: number; // derived, internal sanity only
}

function tier(id: string, credits: number, priceInr: number): TopupTier {
  const perCredit = priceInr / credits;
  return {
    id,
    credits,
    priceInr,
    perCredit: Number(perCredit.toFixed(2)),
    marginPct: Math.round(((perCredit - CREDIT_INR) / perCredit) * 100),
  };
}

export const TOPUP_TIERS: TopupTier[] = [
  tier("topup_500", 500, 1000), //  ₹2.00/cr  · 60% margin
  tier("topup_1000", 1000, 1900), // ₹1.90/cr  · 58% margin
  tier("topup_2500", 2500, 4500), // ₹1.80/cr  · 56% margin
  tier("topup_5000", 5000, 8500), // ₹1.70/cr  · 53% margin
];

export function getTopupTier(id: string): TopupTier | undefined {
  return TOPUP_TIERS.find((t) => t.id === id);
}
