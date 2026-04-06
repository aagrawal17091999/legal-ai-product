-- Supreme Court indexes
CREATE INDEX IF NOT EXISTS idx_sc_year ON supreme_court_cases(year);
CREATE INDEX IF NOT EXISTS idx_sc_judge ON supreme_court_cases(judge);
CREATE INDEX IF NOT EXISTS idx_sc_court ON supreme_court_cases(court);
CREATE INDEX IF NOT EXISTS idx_sc_disposal ON supreme_court_cases(disposal_nature);
CREATE INDEX IF NOT EXISTS idx_sc_title_fts ON supreme_court_cases USING GIN(to_tsvector('english', coalesce(title, '')));
CREATE INDEX IF NOT EXISTS idx_sc_text_fts ON supreme_court_cases USING GIN(to_tsvector('english', coalesce(judgment_text, '')));
CREATE INDEX IF NOT EXISTS idx_sc_desc_fts ON supreme_court_cases USING GIN(to_tsvector('english', coalesce(description, '')));

-- High Court indexes
CREATE INDEX IF NOT EXISTS idx_hc_year ON high_court_cases(year);
CREATE INDEX IF NOT EXISTS idx_hc_judge ON high_court_cases(judge);
CREATE INDEX IF NOT EXISTS idx_hc_court_name ON high_court_cases(court_name);
CREATE INDEX IF NOT EXISTS idx_hc_disposal ON high_court_cases(disposal_nature);
CREATE INDEX IF NOT EXISTS idx_hc_title_fts ON high_court_cases USING GIN(to_tsvector('english', coalesce(title, '')));
CREATE INDEX IF NOT EXISTS idx_hc_text_fts ON high_court_cases USING GIN(to_tsvector('english', coalesce(judgment_text, '')));

-- Case chunks indexes
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON case_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON case_chunks(source_table, source_id);

-- User indexes
CREATE INDEX IF NOT EXISTS idx_users_firebase ON users(firebase_uid);

-- Chat indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id);
