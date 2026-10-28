-- Migration 034: the post-signup onboarding step.
--
-- Right after an account is created the app asks for a mobile number (used only
-- to reach early users for feedback and support) and how they heard about us.
-- The modal can't be dismissed until both are given; onboarded_at is what the
-- client checks, so a NULL here means "show the step".
--
-- referral_source is one of a fixed set of keys (see src/lib/onboarding.ts);
-- referral_detail holds the free text when the user picks "Other".
--
-- Existing users are deliberately left NULL so they see the step on their next
-- visit too — the early users are exactly the ones worth a call.
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_source TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_detail TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP;

COMMIT;
