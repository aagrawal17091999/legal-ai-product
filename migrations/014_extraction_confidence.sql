-- Per-field extraction confidence + method tracking for acts_cited.
-- Enables SQL-based review of low-confidence rows:
--   SELECT id, acts_cited, acts_cited_alternatives
--   FROM supreme_court_cases
--   WHERE acts_cited_confidence < 0.7
--   ORDER BY acts_cited_confidence ASC;

-- Supreme Court
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS acts_cited_method TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS acts_cited_confidence REAL;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS acts_cited_alternatives JSONB DEFAULT '{}';

-- High Court
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS acts_cited_method TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS acts_cited_confidence REAL;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS acts_cited_alternatives JSONB DEFAULT '{}';

-- Indexes for review queries
CREATE INDEX IF NOT EXISTS idx_sc_acts_cited_confidence ON supreme_court_cases(acts_cited_confidence);
CREATE INDEX IF NOT EXISTS idx_sc_acts_cited_method ON supreme_court_cases(acts_cited_method);
CREATE INDEX IF NOT EXISTS idx_hc_acts_cited_confidence ON high_court_cases(acts_cited_confidence);
CREATE INDEX IF NOT EXISTS idx_hc_acts_cited_method ON high_court_cases(acts_cited_method);
