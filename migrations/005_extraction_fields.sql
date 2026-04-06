-- Extraction fields for structured metadata extracted from judgment text
-- Applied to both supreme_court_cases and high_court_cases

-- Supreme Court extraction fields
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS extracted_citation TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS extracted_petitioner TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS extracted_respondent TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS case_category TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS case_number TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS judge_names JSONB DEFAULT '[]';
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS author_judge_name TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS issue_for_consideration TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS headnotes TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS cases_cited JSONB DEFAULT '[]';
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS acts_cited JSONB DEFAULT '[]';
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS keywords JSONB DEFAULT '[]';
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS case_arising_from JSONB DEFAULT '{}';
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS bench_size INTEGER;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS result_of_case TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'pending';
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS extraction_method TEXT;
ALTER TABLE supreme_court_cases ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMP;

-- High Court extraction fields (same structure)
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS extracted_citation TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS extracted_petitioner TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS extracted_respondent TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS case_category TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS case_number TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS judge_names JSONB DEFAULT '[]';
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS author_judge_name TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS issue_for_consideration TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS headnotes TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS cases_cited JSONB DEFAULT '[]';
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS acts_cited JSONB DEFAULT '[]';
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS keywords JSONB DEFAULT '[]';
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS case_arising_from JSONB DEFAULT '{}';
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS bench_size INTEGER;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS result_of_case TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'pending';
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS extraction_method TEXT;
ALTER TABLE high_court_cases ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMP;

-- GIN indexes for JSONB columns (fast filtered queries)
CREATE INDEX IF NOT EXISTS idx_sc_judge_names_gin ON supreme_court_cases USING GIN(judge_names);
CREATE INDEX IF NOT EXISTS idx_sc_acts_cited_gin ON supreme_court_cases USING GIN(acts_cited);
CREATE INDEX IF NOT EXISTS idx_sc_keywords_gin ON supreme_court_cases USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_sc_cases_cited_gin ON supreme_court_cases USING GIN(cases_cited);
CREATE INDEX IF NOT EXISTS idx_sc_category ON supreme_court_cases(case_category);
CREATE INDEX IF NOT EXISTS idx_sc_author_judge ON supreme_court_cases(author_judge_name);
CREATE INDEX IF NOT EXISTS idx_sc_extraction_status ON supreme_court_cases(extraction_status);

CREATE INDEX IF NOT EXISTS idx_hc_judge_names_gin ON high_court_cases USING GIN(judge_names);
CREATE INDEX IF NOT EXISTS idx_hc_acts_cited_gin ON high_court_cases USING GIN(acts_cited);
CREATE INDEX IF NOT EXISTS idx_hc_keywords_gin ON high_court_cases USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_hc_cases_cited_gin ON high_court_cases USING GIN(cases_cited);
CREATE INDEX IF NOT EXISTS idx_hc_category ON high_court_cases(case_category);
CREATE INDEX IF NOT EXISTS idx_hc_author_judge ON high_court_cases(author_judge_name);
CREATE INDEX IF NOT EXISTS idx_hc_extraction_status ON high_court_cases(extraction_status);
