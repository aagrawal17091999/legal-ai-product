-- Migration 029: staff account administration.
--
-- Backs four admin capabilities that previously required a psql session on the
-- production box:
--   1. Grant (or claw back) credits for a single user.
--   2. Put a user on the monthly/yearly plan.
--   3. Cancel a user's subscription or comped plan.
--   4. Read the error log for one user's profile.
--
-- Everything a staff member does to another account is recorded in
-- `admin_actions` — the ledger rows in credit_transactions say WHAT changed but
-- not WHO changed it or why, and for money-adjacent actions that is exactly the
-- question asked after the fact.
BEGIN;

-- ----------------------------------------------------------------------------
-- Comped plans.
--
-- An admin upgrade for a user with no Razorpay subscription grants the plan
-- outright — no money, no subscription id, so none of the subscription.*
-- webhooks will ever fire for it. That has to be an EXPLICIT flag rather than
-- inferred from "plan != free AND razorpay_subscription_id IS NULL", because
-- pre-cutover rows can look like that too, and the expiry sweep in
-- /api/cron/credit-refill must never downgrade a genuine subscriber.
--
-- Semantics (see src/app/api/admin/users/[id]/plan/route.ts):
--   * comped_plan = TRUE  -> plan is granted by staff; subscription_end_date is
--     the expiry, and the refill cron both tops the wallet up monthly and
--     downgrades the user once that date passes.
--   * comped_plan = FALSE -> plan is billing-driven (or the user is free).
-- Cleared whenever the user is downgraded or starts a real subscription.
ALTER TABLE users ADD COLUMN IF NOT EXISTS comped_plan BOOLEAN NOT NULL DEFAULT FALSE;

-- ----------------------------------------------------------------------------
-- Audit trail for staff actions taken against another user's account.
CREATE TABLE IF NOT EXISTS admin_actions (
    id              BIGSERIAL PRIMARY KEY,
    -- Who did it. Kept even if the target user is deleted; if the ACTOR is ever
    -- deleted the row survives with a NULL actor rather than vanishing, which is
    -- the point of an audit log.
    actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_email     TEXT NOT NULL,
    target_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_email    TEXT NOT NULL,
    action          TEXT NOT NULL,   -- grant_credits | revoke_credits | set_plan | cancel_plan
    reason          TEXT,
    details         JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target
    ON admin_actions (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_actor
    ON admin_actions (actor_user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Per-user error log. The existing indexes cover category/severity/created_at;
-- filtering by user_id (the admin user profile view) had no index and fell back
-- to a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS idx_error_logs_user
    ON error_logs (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- Admin user search matches on email; the column has no unique constraint and
-- so no index of its own.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

COMMIT;
