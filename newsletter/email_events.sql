-- email_events table — stores incoming Resend webhook events (opens, clicks, bounces, complaints)
-- Run in Supabase SQL Editor after applying newsletter_sends.sql.

CREATE TABLE IF NOT EXISTS email_events (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- FK to the newsletter_sends record this event belongs to (null if unmatched)
  send_id        UUID REFERENCES newsletter_sends(id),
  -- Resend's internal email ID (used to match events back to sends)
  email_id       TEXT,
  -- Event type: email.opened | email.clicked | email.bounced | email.complained
  type           TEXT NOT NULL,
  recipient_email TEXT,
  -- Full Resend webhook data payload for debugging
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_events_send_id   ON email_events (send_id);
CREATE INDEX IF NOT EXISTS idx_email_events_type      ON email_events (type);
CREATE INDEX IF NOT EXISTS idx_email_events_email_id  ON email_events (email_id);
CREATE INDEX IF NOT EXISTS idx_email_events_created   ON email_events (created_at DESC);

-- RLS: only service role can access
ALTER TABLE email_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON email_events
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
