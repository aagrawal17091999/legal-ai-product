-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- Supreme Court cases
CREATE TABLE IF NOT EXISTS supreme_court_cases (
    id SERIAL PRIMARY KEY,
    title TEXT,
    petitioner TEXT,
    respondent TEXT,
    description TEXT,
    judge TEXT,
    author_judge TEXT,
    citation TEXT,
    case_id TEXT,
    cnr TEXT,
    decision_date TEXT,
    disposal_nature TEXT,
    court TEXT DEFAULT 'Supreme Court of India',
    available_languages TEXT,
    path TEXT,
    nc_display TEXT,
    year INTEGER,
    judgment_text TEXT,
    pdf_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- High Court cases
CREATE TABLE IF NOT EXISTS high_court_cases (
    id SERIAL PRIMARY KEY,
    court_code TEXT,
    title TEXT,
    description TEXT,
    judge TEXT,
    pdf_link TEXT,
    cnr TEXT,
    date_of_registration TEXT,
    decision_date DATE,
    disposal_nature TEXT,
    court_name TEXT,
    year INTEGER,
    bench TEXT,
    judgment_text TEXT,
    pdf_url TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
