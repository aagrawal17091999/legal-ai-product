-- Migration 035: the referral program.
--
-- Rule: every 5 people a user refers who START PAYING (a subscription charge,
-- not a signup) earns the referrer one free month — the next renewal is
-- skipped and the one after is charged. Unlimited referrals, unlimited months.
--
-- Naming: users.referral_source / referral_detail (migration 034) already mean
-- "how did you hear about us" and are untouched. Everything here says referrer /
-- referee / referral_code to keep the two apart.
BEGIN;

-- ----------------------------------------------------------------------------
-- The code a user shares. Allocated lazily (the first time they open the
-- referral section), stored uppercase, so lookups are exact matches.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code
    ON users (referral_code) WHERE referral_code IS NOT NULL;

-- Denormalized from referrals for the admin profile; referrals is authoritative.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER
    REFERENCES users(id) ON DELETE SET NULL;

-- ----------------------------------------------------------------------------
-- One row per referred account. A user can be referred at most once
-- (UNIQUE referee), and only by someone else.
--
-- status:
--   signed_up    -> claimed a code, hasn't paid
--   pending      -> first subscription charge landed; counts once qualifies_at
--                   passes without a refund (7-day window)
--   qualified    -> counts toward the referrer's free months
--   disqualified -> refunded inside the window, self-referral, or staff
CREATE TABLE IF NOT EXISTS referrals (
    id                     BIGSERIAL PRIMARY KEY,
    referrer_user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    code_used              TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'signed_up'
                           CHECK (status IN ('signed_up', 'pending', 'qualified', 'disqualified')),
    first_payment_id       TEXT,
    first_subscription_id  TEXT,
    first_paid_at          TIMESTAMP,
    qualifies_at           TIMESTAMP,
    qualified_at           TIMESTAMP,
    disqualified_reason    TEXT,
    created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (referrer_user_id <> referee_user_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer
    ON referrals (referrer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_referrals_pending_due
    ON referrals (qualifies_at) WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- One row per free month earned. milestone N covers qualified referrals
-- 5N-4..5N, and UNIQUE (referrer, milestone) is what makes earning idempotent:
-- recomputing floor(qualified / 5) can never mint the same month twice.
--
-- status:
--   banked    -> earned, waiting for the referrer's next renewal
--   scheduled -> in progress: the subscription is paused for [cycle_start,
--                cycle_end), or (method = refund) the charge at cycle_start
--                will be refunded
--   applied   -> the month has been given
--   revoked   -> withdrawn by staff (fraud); its milestone stays used
--   forfeited -> lost because the referrer cancelled; its milestone stays used
--
-- method: pause | refund are done by the app (cron or a staff button);
-- manual means staff did it outside the app and only recorded it here.
CREATE TABLE IF NOT EXISTS referral_rewards (
    id                        BIGSERIAL PRIMARY KEY,
    referrer_user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone                 INTEGER NOT NULL CHECK (milestone > 0),
    status                    TEXT NOT NULL DEFAULT 'banked'
                              CHECK (status IN ('banked', 'scheduled', 'applied', 'revoked', 'forfeited')),
    method                    TEXT CHECK (method IN ('pause', 'refund', 'manual')),
    razorpay_subscription_id  TEXT,
    -- The renewal that is skipped, and when billing resumes.
    cycle_start               TIMESTAMP,
    cycle_end                 TIMESTAMP,
    refund_id                 TEXT,
    -- 'cron' or the staff member's email.
    actor                     TEXT,
    note                      TEXT,
    earned_at                 TIMESTAMP NOT NULL DEFAULT NOW(),
    scheduled_at              TIMESTAMP,
    applied_at                TIMESTAMP,
    updated_at                TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (referrer_user_id, milestone)
);
-- At most one month in progress per referrer: consecutive months are chained
-- one after another, never run in parallel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_rewards_one_scheduled
    ON referral_rewards (referrer_user_id) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_referral_rewards_status
    ON referral_rewards (status, referrer_user_id);

COMMIT;
