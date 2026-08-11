import { test } from "node:test";
import assert from "node:assert";
import { EVENTS, CLIENT_ALLOWED } from "../events";

/**
 * Two invariants here are load-bearing rather than cosmetic.
 *
 * The allowlist is a security boundary: /api/analytics/event is reachable by
 * anyone, so anything it will forward can be forged. A revenue event slipping
 * into CLIENT_ALLOWED would let a stranger inject `subscription_activated` and
 * quietly corrupt the funnel you make pricing decisions from.
 *
 * The naming invariant matters because Mixpanel silently creates a new event on
 * any string it hasn't seen — a typo doesn't error, it splits a funnel in half
 * and you find out weeks later.
 */

test("the client may only send interaction events, never anything of consequence", () => {
  const forbidden = [
    EVENTS.SIGNED_UP,
    EVENTS.SUBSCRIPTION_ACTIVATED,
    EVENTS.SUBSCRIPTION_RENEWED,
    EVENTS.TOPUP_PURCHASED,
    EVENTS.CHECKOUT_STARTED,
    EVENTS.RESEARCH_ANSWERED,
    EVENTS.OCR_COMPLETED,
    EVENTS.TRANSLATE_COMPLETED,
    EVENTS.OUT_OF_CREDITS,
  ];
  for (const e of forbidden) {
    assert.ok(!CLIENT_ALLOWED.has(e), `${e} must not be client-sendable — it can be forged`);
  }
});

test("every allowlisted event is a real declared event", () => {
  const all = new Set<string>(Object.values(EVENTS));
  for (const e of CLIENT_ALLOWED) {
    assert.ok(all.has(e), `${e} is allowlisted but not declared in EVENTS`);
  }
});

test("event names are unique", () => {
  const values = Object.values(EVENTS);
  assert.strictEqual(
    new Set(values).size,
    values.length,
    "two keys map to the same event name — one funnel would silently absorb the other"
  );
});

test("event names follow lowercase snake_case", () => {
  for (const name of Object.values(EVENTS)) {
    assert.match(
      name,
      /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
      `${name} breaks the naming convention`
    );
  }
});
