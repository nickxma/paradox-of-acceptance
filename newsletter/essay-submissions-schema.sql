-- essay_submissions table — guest essay submission portal
-- Run in Supabase SQL Editor before using the submissions feature.
--
-- Status lifecycle:
--   pending  → reviewed → accepted  → (admin promotes to essays table)
--                       → rejected
--
-- Rate limit enforced at the application layer: 1 submission per email per 7 days.

-- Depends on update_updated_at_col() from cron/schema.sql.
-- Ensure that function exists before running this.

CREATE TABLE IF NOT EXISTS essay_submissions (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,          -- markdown essay body
  bio          TEXT,                   -- optional author bio
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'reviewed', 'accepted', 'rejected')),
  admin_notes  TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_essay_submissions_email       ON essay_submissions (email);
CREATE INDEX IF NOT EXISTS idx_essay_submissions_status      ON essay_submissions (status);
CREATE INDEX IF NOT EXISTS idx_essay_submissions_submitted_at ON essay_submissions (submitted_at DESC);

ALTER TABLE essay_submissions ENABLE ROW LEVEL SECURITY;

-- Only the service role (server-side code) can read or write submissions.
CREATE POLICY "Service role full access essay_submissions" ON essay_submissions
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER essay_submissions_updated_at
  BEFORE UPDATE ON essay_submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_col();
