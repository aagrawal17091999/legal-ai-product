-- Error logging table for centralized error tracking across the product
-- Categories cover all major touchpoints: API calls, search, auth, payments, pipeline, frontend

CREATE TYPE error_category AS ENUM (
  'extraction', 'fetching', 'search', 'auth',
  'payment', 'chat', 'database', 'pipeline', 'frontend'
);

CREATE TYPE error_severity AS ENUM ('warning', 'error', 'critical');

CREATE TABLE IF NOT EXISTS error_logs (
  id BIGSERIAL PRIMARY KEY,
  category error_category NOT NULL,
  severity error_severity NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  stack_trace TEXT,
  metadata JSONB DEFAULT '{}',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  endpoint TEXT,
  method TEXT,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns (dashboards, alerts)
CREATE INDEX idx_error_logs_category ON error_logs(category);
CREATE INDEX idx_error_logs_severity ON error_logs(severity);
CREATE INDEX idx_error_logs_created_at ON error_logs(created_at DESC);
CREATE INDEX idx_error_logs_unresolved ON error_logs(resolved) WHERE NOT resolved;
