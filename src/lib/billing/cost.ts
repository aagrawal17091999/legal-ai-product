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

/** Rupees of COGS represented by one credit. 2000 credits = ₹1,600 (Pro pool). */
export const CREDIT_INR = Number(process.env.BILLING_CREDIT_INR) || 0.8;

/**
 * Allowances in credits. `monthly`/`yearly` are the allowance PER MONTH — a
 * yearly subscriber gets the same 2,000 credits a month as a monthly one, they
 * just pay for twelve months up front.
 *
 * This used to be read as "credits per billing cycle", which quietly made the
 * yearly plan a 12x underdelivery: `subscription.charged` fires once per cycle,
 * so a yearly subscriber was granted the month's allowance for a WHOLE YEAR
 * while a monthly subscriber got it every month for the same per-month price. The
 * intra-year refills now come from /api/cron/credit-refill.
 */
export const PLAN_CREDITS = {
  monthly: 2000,
  yearly: 2000,
  freeLifetime: 200,
} as const;

/** GST charged on top of every listed price (subscriptions and top-ups). */
export const GST_RATE = 0.18;

/** Add GST to a rupee amount, rounded to whole rupees. */
export function withGst(baseInr: number): number {
  return Math.round(baseInr * (1 + GST_RATE));
}

/**
 * One month after `from`, clamping the day-of-month so the 31st of a month maps
 * to the last day of a 30-day month instead of silently rolling into the next
 * one (plain JS Date does that: Jan 31 + 1 month = Mar 2/3, which would skip
 * February's refill entirely).
 *
 * Deliberately all-UTC. The local-time getters would make a subscriber's refill
 * date depend on the server's timezone, so the same wallet could advance a day
 * early or late after a box move — and period boundaries are stored as
 * timestamptz, which has no local component to honour anyway.
 */
export function addOneMonth(from: Date): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * Expiry of a staff-comped plan: `months` whole months after `from`.
 *
 * Built on addOneMonth rather than `setMonth(m + n)` so day-of-month clamping
 * applies at every step. Comping one month from 31 January with plain Date
 * arithmetic lands on 2 or 3 March — a free extra day or two each time, and a
 * skipped February refill boundary.
 */
export function compedPlanEnd(from: Date, months: number): Date {
  let end = new Date(from);
  for (let i = 0; i < months; i++) end = addOneMonth(end);
  return end;
}

/**
 * When the current credit pool expires and is refilled. The pool is ALWAYS a
 * one-month window: for a monthly plan that coincides with the billing cycle,
 * for a yearly plan it is an internal refill window inside the paid year.
 * Never runs past the subscription's own end.
 */
export function creditPeriodEnd(
  plan: "monthly" | "yearly",
  subscriptionEnd: Date,
  from: Date = new Date()
): Date {
  if (plan === "monthly") return subscriptionEnd;
  const oneMonth = addOneMonth(from);
  return oneMonth < subscriptionEnd ? oneMonth : subscriptionEnd;
}

/**
 * USD per 1,000,000 tokens, per Anthropic / Voyage list pricing.
 * cacheRead ≈ 0.1× input, cacheWrite ≈ 1.25× input (5-min TTL).
 */
type Rate = { input: number; output?: number; cacheRead?: number; cacheWrite?: number };
const RATES: Record<string, Rate> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Sonnet 5 is billed at LIST price even while Anthropic's introductory rate
  // ($2/$10, through 2026-08-31) is in force: metering the higher number keeps
  // credit charges conservative rather than under-charging and having costs
  // jump when the intro period ends. Note the prefix matcher cannot help here —
  // "claude-sonnet-5" does not start with "claude-sonnet-4-6", so without this
  // row `rateKeyFor` returns null and every chat turn meters as FREE.
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
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
 * Top-up packs. Priced off the SAME ratio the Pro plan now delivers — ₹2,500
 * for 2,000 credits, i.e. ₹1.25/credit — with the usual volume discount decaying
 * below that, never past ₹1.10/credit. That holds ≥27% gross margin on every
 * tier (cost basis is ₹0.80/credit), in line with the plan's own margin, so
 * topping up is never a worse deal per credit than the subscription itself.
 * `id` is what the client sends to /credits/order.
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
  tier("topup_500", 500, 625), //   ₹1.25/cr · 36% margin — matches the plan
  tier("topup_1000", 1000, 1200), // ₹1.20/cr · 33% margin
  tier("topup_2500", 2500, 2875), // ₹1.15/cr · 30% margin
  tier("topup_5000", 5000, 5500), // ₹1.10/cr · 27% margin
];

export function getTopupTier(id: string): TopupTier | undefined {
  return TOPUP_TIERS.find((t) => t.id === id);
}
