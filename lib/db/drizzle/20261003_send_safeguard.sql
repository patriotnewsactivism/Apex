-- Additive send-safeguard tables. No drops. Times are timestamptz (UTC).
-- operator_send_code stores a scrypt hash and salt only.

CREATE TABLE IF NOT EXISTS send_jobs (
  id text PRIMARY KEY,
  campaign_key text,
  story_key text,
  full_auto boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'waiting_confirm',
  confirm1_at timestamptz,
  confirm2_at timestamptz,
  code_verified_at timestamptz,
  content_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS send_jobs_campaign_created_idx ON send_jobs (campaign_key, created_at);
CREATE INDEX IF NOT EXISTS send_jobs_story_created_idx ON send_jobs (story_key, created_at);
CREATE INDEX IF NOT EXISTS send_jobs_status_idx ON send_jobs (status);

CREATE TABLE IF NOT EXISTS send_job_recipients (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  channel text NOT NULL,
  destination text NOT NULL,
  message_text text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  released boolean NOT NULL DEFAULT false,
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS send_job_recipients_job_idx ON send_job_recipients (job_id);

CREATE TABLE IF NOT EXISTS send_safeguard_events (
  id text PRIMARY KEY,
  job_id text,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS send_safeguard_events_job_created_idx ON send_safeguard_events (job_id, created_at);

CREATE TABLE IF NOT EXISTS operator_send_code (
  id text PRIMARY KEY DEFAULT 'operator',
  code_hash text,
  salt text,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operator_dashboard_sessions (
  token_hash text PRIMARY KEY,
  origin text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
