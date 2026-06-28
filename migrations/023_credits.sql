-- Migration 023: Usage metering + credit wallet.
--
-- Replaces the old "5 lifetime chats / unlimited Pro" model (migration 017,
-- auth.ts checkQueryLimit) with a single cost-metered credit pool:
--
--   * 1 credit  = ₹0.80 of measured AI cost (Claude + Voyage tokens).
--   * Pro plan  = 1000 credits / billing cycle, no rollover (reset on every
--                 subscription.activated / subscription.charged webhook).
--   * Free tier = 100 credits, lifetime (one-time signup grant, never resets).
--   * Top-ups   = persistent purchased credits (tiered, see billing/cost.ts).
--
-- remaining = plan_credits + topup_credits. Debits drain plan_credits first,
-- then topup_credits, and MAY go one action negative ("complete the in-flight
-- request, then block"). requireCredits() blocks new work once remaining <= 0.
BEGIN;

-- Current materialized balance, one row per user. Split into two buckets so a
-- monthly Pro reset can zero plan_credits without touching purchased/lifetime
-- credits (which live in topup_credits).
CREATE TABLE IF NOT EXISTS credit_balances (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_credits   NUMERIC NOT NULL DEFAULT 0,   -- resets each Pro billing cycle
    topup_credits  NUMERIC NOT NULL DEFAULT 0,   -- persistent: free grant + purchases
    period_start   TIMESTAMP,
    period_end     TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One row per finalized billable request/job. The audit + analytics trail and
-- the source of truth for "what did this action actually cost us".
CREATE TABLE IF NOT EXISTS usage_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature         TEXT NOT NULL,    -- chat | workspace_chat | translate | ocr | ingest
    ref_id          TEXT,             -- message id / job id, for tracing
    model_breakdown JSONB,            -- per-model token tallies (see meter.ts)
    cost_inr        NUMERIC NOT NULL, -- measured rupee COGS
    credits_charged NUMERIC NOT NULL, -- ceil(cost_inr / 0.80)
    enforced        BOOLEAN NOT NULL DEFAULT TRUE, -- false during shadow mode
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_feature ON usage_events (feature, created_at DESC);

-- Everything that ADDS credits: signup grant, monthly reset, top-up purchase,
-- manual refund. (Debits live in usage_events.)
CREATE TABLE IF NOT EXISTS credit_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                TEXT NOT NULL,  -- signup_grant | monthly_reset | topup | refund
    credits             NUMERIC NOT NULL,
    razorpay_payment_id TEXT,
    razorpay_order_id   TEXT,
    amount_inr          NUMERIC,        -- what the user paid (top-ups only)
    created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions (user_id, created_at DESC);
-- Idempotency: a captured Razorpay payment must credit a wallet at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_tx_payment
    ON credit_transactions (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

-- Locked outputs for async jobs: when a job's debit pushes the wallet negative,
-- the finished output is withheld until the user tops up.
ALTER TABLE translation_jobs ADD COLUMN IF NOT EXISTS output_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE translation_jobs ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMP;
ALTER TABLE ocr_jobs        ADD COLUMN IF NOT EXISTS output_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ocr_jobs        ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMP;

-- ----------------------------------------------------------------------------
-- Seed balances for existing users (one-time cutover).
--   Pro  (monthly/yearly) -> 1000 plan_credits, period = now..subscription_end.
--   Free                  -> 100 topup_credits (lifetime grant).
-- Idempotent: ON CONFLICT DO NOTHING so re-running never re-grants.
-- ----------------------------------------------------------------------------
INSERT INTO credit_balances (user_id, plan_credits, topup_credits, period_start, period_end)
SELECT
    u.id,
    CASE WHEN u.plan IN ('monthly', 'yearly') THEN 1000 ELSE 0 END,
    CASE WHEN u.plan IN ('monthly', 'yearly') THEN 0 ELSE 100 END,
    NOW(),
    u.subscription_end_date
FROM users u
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO credit_transactions (user_id, type, credits)
SELECT
    u.id,
    CASE WHEN u.plan IN ('monthly', 'yearly') THEN 'monthly_reset' ELSE 'signup_grant' END,
    CASE WHEN u.plan IN ('monthly', 'yearly') THEN 1000 ELSE 100 END
FROM users u
-- Only seed users who have no ledger history yet, so re-running is a no-op.
WHERE NOT EXISTS (SELECT 1 FROM credit_transactions t WHERE t.user_id = u.id);

COMMIT;
