import { test } from "node:test";
import assert from "node:assert";
import {
  addOneMonth,
  creditPeriodEnd,
  compedPlanEnd,
  withGst,
  PLAN_CREDITS,
} from "../cost";

/**
 * The Pro allowance is per MONTH, but Razorpay's `subscription.charged` fires
 * once per BILLING CYCLE — once a year on the yearly plan. Reading the two as
 * the same thing made yearly a 12x underdelivery: ₹20,000 bought 1,000 credits
 * for twelve months while ₹2,000/month bought 12,000 over the same year.
 *
 * The fix is that a credit period is always one month, with the intra-year
 * refills issued by /api/cron/credit-refill. These tests pin the date maths that
 * decides when those refills land, because the failure mode is silent: a wrong
 * boundary doesn't throw, it just quietly under- or over-grants a paying user.
 */

test("a yearly subscriber's credit period is one month, not one year", () => {
  const start = new Date("2026-03-15T00:00:00Z");
  const subEnd = new Date("2027-03-15T00:00:00Z");

  const period = creditPeriodEnd("yearly", subEnd, start);

  assert.deepStrictEqual(period, new Date("2026-04-15T00:00:00Z"));
  assert.ok(period < subEnd, "credit period must not span the whole subscription");
});

test("a monthly subscriber's credit period is the billing cycle itself", () => {
  const subEnd = new Date("2026-04-15T00:00:00Z");
  assert.deepStrictEqual(
    creditPeriodEnd("monthly", subEnd, new Date("2026-03-15T00:00:00Z")),
    subEnd
  );
});

test("the credit period never runs past the subscription that paid for it", () => {
  // Final month of a yearly plan: one month out would overshoot the paid term.
  const now = new Date("2027-03-01T00:00:00Z");
  const subEnd = new Date("2027-03-15T00:00:00Z");
  assert.deepStrictEqual(creditPeriodEnd("yearly", subEnd, now), subEnd);
});

test("both plans carry the same per-month allowance", () => {
  assert.strictEqual(PLAN_CREDITS.yearly, PLAN_CREDITS.monthly);
});

test("month-end dates clamp instead of rolling into the next month", () => {
  // Plain JS Date arithmetic turns Jan 31 + 1 month into Mar 2/3, which would
  // silently skip February's refill entirely.
  assert.deepStrictEqual(
    addOneMonth(new Date("2026-01-31T00:00:00Z")),
    new Date("2026-02-28T00:00:00Z")
  );
  assert.deepStrictEqual(
    addOneMonth(new Date("2028-01-31T00:00:00Z")),
    new Date("2028-02-29T00:00:00Z"),
    "leap year"
  );
  assert.deepStrictEqual(
    addOneMonth(new Date("2026-03-31T00:00:00Z")),
    new Date("2026-04-30T00:00:00Z")
  );
});

test("adding a month crosses the year boundary", () => {
  assert.deepStrictEqual(
    addOneMonth(new Date("2026-12-15T00:00:00Z")),
    new Date("2027-01-15T00:00:00Z")
  );
});

test("twelve successive months land on the same day and advance exactly a year", () => {
  // The refill cron advances from the PREVIOUS boundary, so any per-step drift
  // would compound across the eleven intra-year refills.
  let d = new Date("2026-05-10T00:00:00Z");
  for (let i = 0; i < 12; i++) d = addOneMonth(d);
  assert.deepStrictEqual(d, new Date("2027-05-10T00:00:00Z"));
});

test("GST is added on top of the listed price", () => {
  assert.strictEqual(withGst(1000), 1180);
  assert.strictEqual(withGst(2000), 2360);
  assert.strictEqual(withGst(20000), 23600);
});

test("GST rounds to whole rupees so Razorpay never sees a fractional paise", () => {
  const total = withGst(1900);
  assert.strictEqual(total, 2242); // 1900 * 1.18 = 2242
  assert.strictEqual(Number.isInteger(total), true);
});

/**
 * A comped plan (admin console, migration 029) has no Razorpay object to tell us
 * when it ends, so its expiry is pure date maths — and the same day-of-month
 * trap as the refill boundaries above. Plain `setMonth` on 31 January silently
 * hands out an extra day or two per month comped.
 */
test("a comped plan clamps the day of month instead of rolling into the next", () => {
  assert.deepStrictEqual(
    compedPlanEnd(new Date("2026-01-31T00:00:00Z"), 1),
    new Date("2026-02-28T00:00:00Z")
  );
});

test("comping several months walks month by month, not one big jump", () => {
  // Jan 31 -> Feb 28 -> Mar 28: the clamp sticks once applied, which is what
  // keeps every subsequent refill boundary on the same day.
  assert.deepStrictEqual(
    compedPlanEnd(new Date("2026-01-31T00:00:00Z"), 2),
    new Date("2026-03-28T00:00:00Z")
  );
});

test("a twelve-month comp lands on the same date a year later", () => {
  assert.deepStrictEqual(
    compedPlanEnd(new Date("2026-08-21T00:00:00Z"), 12),
    new Date("2027-08-21T00:00:00Z")
  );
});

// ── every model the app can actually call must have a billing rate ──────────
// A model id with no RATES row (and no prefix match) meters as ZERO, silently.
// `claude-sonnet-5` does not share a prefix with `claude-sonnet-4-6`, so the
// Sonnet 5 swap would have billed every chat turn as free without this guard.
test("configured models all resolve to a billing rate", async () => {
  const { rateKeyFor, claudeCostInr } = await import("../cost.ts");
  const configured = [
    process.env.CHAT_MODEL?.trim() || "claude-sonnet-5",
    process.env.GROUNDING_PATCH_MODEL?.trim() || "claude-sonnet-5",
    process.env.FAITHFULNESS_MODEL?.trim() || "claude-haiku-4-5-20251001",
    process.env.DECOMPOSE_MODEL?.trim() || "claude-haiku-4-5-20251001",
    process.env.REFLECT_MODEL?.trim() || "claude-haiku-4-5-20251001",
  ];
  for (const m of configured) {
    assert.ok(rateKeyFor(m), `no billing rate for configured model "${m}"`);
    assert.ok(
      claudeCostInr(m, { input_tokens: 1000, output_tokens: 1000 }) > 0,
      `model "${m}" meters as free`
    );
  }
});
