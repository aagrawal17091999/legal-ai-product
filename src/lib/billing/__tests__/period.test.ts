import { test } from "node:test";
import assert from "node:assert";
import { addOneMonth, creditPeriodEnd, withGst, PLAN_CREDITS } from "../cost";

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
