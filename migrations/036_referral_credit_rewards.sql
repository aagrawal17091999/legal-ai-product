-- Migration 036: referral rewards are wallet credits, not skipped renewals.
--
-- Decided 2026-10-28, before the program ever went live: every 5 qualified
-- referrals now earn 2,000 credits (one month of the Pro allowance) added to
-- the referrer's persistent top-up pool, instead of a free month delivered by
-- pausing their Razorpay subscription. No Razorpay dependency, same reward for
-- free, monthly and yearly users, nothing to undo on cancel.
--
-- referral_rewards keeps one row per earned reward (UNIQUE milestone is still
-- what makes earning idempotent). A row is inserted 'banked' and moved to
-- 'applied' once its credits are in the wallet; the grant itself is idempotent
-- on 'refreward:<id>' in credit_transactions. The pause-era columns
-- (cycle_start, cycle_end, refund_id, razorpay_subscription_id) stay, unused —
-- additive-only migrations (see README) — and no rows ever used them in prod.
BEGIN;

ALTER TABLE referral_rewards DROP CONSTRAINT IF EXISTS referral_rewards_method_check;
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_method_check
    CHECK (method IN ('pause', 'refund', 'manual', 'credits'));

-- How many credits a reward put in the wallet, so a later change to the
-- reward size never rewrites history.
ALTER TABLE referral_rewards ADD COLUMN IF NOT EXISTS credits INTEGER;

COMMIT;
