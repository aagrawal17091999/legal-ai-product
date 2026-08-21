-- Migration 031: de-duplicate signup grants and normalize the free allowance.
--
-- grantSignupCredits() guarded itself with a SELECT-then-INSERT on the ledger,
-- which is a check-then-act race. auth.ts calls it on every user upsert, so a
-- first login that fanned out into several concurrent requests had each one read
-- an empty ledger and insert its own grant. The partial unique index on
-- razorpay_payment_id did not catch it because signup grants left that column
-- NULL. Result: users with 2x and 3x the intended free credits, milliseconds
-- apart. credits.ts now passes idempotencyKey = 'signup:<id>' so the database
-- enforces exactly-once; this migration cleans up the rows that got through and
-- backfills the key so the index covers them from here on.
--
-- Free balances are set to a FLAT 200 credits regardless of prior consumption,
-- per product decision — the affected users keep what they spent. This is
-- deliberately NOT a grants-minus-usage reconciliation.
BEGIN;

-- 1. Collapse each user's duplicate signup grants down to their earliest row.
DELETE FROM credit_transactions t
      USING credit_transactions keep
      WHERE t.user_id = keep.user_id
        AND t.type    = 'signup_grant'
        AND keep.type = 'signup_grant'
        AND (keep.created_at, keep.id) < (t.created_at, t.id);

-- 2. Restate the surviving grant as the current allowance and claim the
--    idempotency key, so the partial unique index blocks any future duplicate.
UPDATE credit_transactions
   SET credits             = 200,
       razorpay_payment_id = 'signup:' || user_id
 WHERE type = 'signup_grant'
   AND razorpay_payment_id IS NULL;

-- 3. Flat 200 for every free user's lifetime bucket. Pro users are untouched:
--    their allowance lives in plan_credits and resets per billing cycle.
UPDATE credit_balances b
   SET topup_credits = 200,
       updated_at    = NOW()
  FROM users u
 WHERE u.id = b.user_id
   AND u.plan = 'free';

-- 4. Free users who never materialized a balance row still get the allowance.
INSERT INTO credit_balances (user_id, plan_credits, topup_credits)
SELECT u.id, 0, 200 FROM users u WHERE u.plan = 'free'
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
