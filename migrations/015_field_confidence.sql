-- Per-field extraction confidence + method + alternatives for every
-- high-value extracted field. Enables SQL-based review of low-confidence
-- rows on a per-field basis:
--
--   SELECT id, cases_cited, cases_cited_alternatives
--   FROM supreme_court_cases
--   WHERE cases_cited_confidence < 0.7
--   ORDER BY cases_cited_confidence ASC;
--
-- Existing columns from migration 006 (acts_cited_*) are untouched.

DO $$
DECLARE
    tbl TEXT;
    fld TEXT;
    fields TEXT[] := ARRAY[
        'issue_for_consideration',
        'headnotes',
        'cases_cited',
        'keywords',
        'case_arising_from',
        'judge_names',
        'author_judge_name',
        'extracted_petitioner',
        'extracted_respondent',
        'case_category',
        'case_number',
        'extracted_citation',
        'result_of_case'
    ];
    tables TEXT[] := ARRAY['supreme_court_cases', 'high_court_cases'];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        FOREACH fld IN ARRAY fields LOOP
            EXECUTE format(
                'ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I TEXT',
                tbl, fld || '_method'
            );
            EXECUTE format(
                'ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I REAL',
                tbl, fld || '_confidence'
            );
            EXECUTE format(
                'ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I JSONB DEFAULT ''{}''',
                tbl, fld || '_alternatives'
            );
            -- Partial index on confidence for review queries
            EXECUTE format(
                'CREATE INDEX IF NOT EXISTS %I ON %I (%I) WHERE %I < 0.7',
                'idx_' || substring(tbl, 1, 2) || '_' || fld || '_lowconf',
                tbl,
                fld || '_confidence',
                fld || '_confidence'
            );
        END LOOP;
    END LOOP;
END $$;
