-- Chat sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER REFERENCES users(id),
    title TEXT,
    filters JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    cited_cases JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Case chunks with embeddings
CREATE TABLE IF NOT EXISTS case_chunks (
    id SERIAL PRIMARY KEY,
    source_table TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding vector(1024),
    created_at TIMESTAMP DEFAULT NOW()
);
