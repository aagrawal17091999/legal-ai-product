-- Migration 025: per-account "unlimited credits" flag.
--
-- Motivation:
--   Some accounts (internal test/demo, comped users) should never be metered or
--   blocked, regardless of their credit_balances row or BILLING_ENFORCE. Rather
--   than park a giant topup_credits balance (which still slowly draws down and
--   pollutes the ledger), we gate on an explicit boolean on the user.
--
-- Semantics (see src/lib/billing/credits.ts + meter.ts):
--   * requireCredits() never 402s an unlimited user.
--   * finalizeMeter() still records the usage_events row (so COGS analytics stay
--     accurate) but does NOT debit the wallet — so the balance never moves.
--
-- To grant a user unlimited credits after deploying this migration:
--   UPDATE users SET unlimited_credits = TRUE WHERE email = 'test@gmail.com';
-- (email is not unique in this schema — confirm the row count first with
--  SELECT id, email FROM users WHERE email = 'test@gmail.com';)

ALTER TABLE users ADD COLUMN IF NOT EXISTS unlimited_credits BOOLEAN NOT NULL DEFAULT FALSE;
