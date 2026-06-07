-- Switch the free tier from a daily quota to a lifetime quota.
-- queries_used_total never resets; free users get FREE_QUERY_LIMIT total, ever.
ALTER TABLE users ADD COLUMN IF NOT EXISTS queries_used_total INTEGER DEFAULT 0;

-- Best-effort seed so existing users don't get a fresh allotment on cutover:
-- carry over whatever they'd already spent today.
UPDATE users SET queries_used_total = queries_used_today
WHERE queries_used_total = 0 AND queries_used_today > 0;
