-- Users (synced from Firebase)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    firebase_uid TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    photo_url TEXT,
    plan TEXT DEFAULT 'free',
    queries_used_today INTEGER DEFAULT 0,
    queries_reset_date DATE DEFAULT CURRENT_DATE,
    razorpay_customer_id TEXT,
    razorpay_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    subscription_end_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
