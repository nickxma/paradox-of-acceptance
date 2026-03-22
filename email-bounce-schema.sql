-- email-bounce-schema.sql
-- Bounce and complaint handling for OLU-423
-- Run in Supabase SQL Editor after supabase-subscribers-schema.sql

-- ─── Update subscribers status constraint ─────────────────────────────────────
-- Add 'complained' as an explicit status so the admin can see complaint-based
-- suppressions separately from manual unsubscribes.
-- NOTE: complaint events set status = 'unsubscribed' per Resend spec; 'complained'
-- is reserved for manual override if needed.

ALTER TABLE subscribers DROP CONSTRAINT IF EXISTS subscribers_status_check;
ALTER TABLE subscribers
  ADD CONSTRAINT subscribers_status_check
  CHECK (status IN ('active', 'pruned', 'bounced', 'unsubscribed', 'complained'));

-- ─── Complaints table ─────────────────────────────────────────────────────────
-- Records every email.complained event received from Resend.
-- Used for the complaint_rate metric in GET /api/admin/email/health.

CREATE TABLE IF NOT EXISTS complaints (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  email        TEXT        NOT NULL,
  complained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_id   TEXT        -- Resend email_id from webhook payload
);

CREATE INDEX IF NOT EXISTS idx_complaints_email        ON complaints (email);
CREATE INDEX IF NOT EXISTS idx_complaints_complained_at ON complaints (complained_at DESC);

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON complaints
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── email_send_log table ─────────────────────────────────────────────────────
-- Per-email outbound audit trail: records every individual send attempt.
-- Status 'skipped' means the address was suppressed before the Resend API was called.

CREATE TABLE IF NOT EXISTS email_send_log (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  email           TEXT        NOT NULL,
  type            TEXT        NOT NULL,   -- 'onboarding_step_1', 'welcome', 'preferences_link', etc.
  status          TEXT        NOT NULL CHECK (status IN ('sent', 'skipped', 'failed')),
  skip_reason     TEXT,                   -- subscriber status at skip time, e.g. 'bounced'
  resend_email_id TEXT,                   -- Resend email ID on successful send
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_email   ON email_send_log (email);
CREATE INDEX IF NOT EXISTS idx_email_send_log_type    ON email_send_log (type);
CREATE INDEX IF NOT EXISTS idx_email_send_log_status  ON email_send_log (status);
CREATE INDEX IF NOT EXISTS idx_email_send_log_created ON email_send_log (created_at DESC);

ALTER TABLE email_send_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON email_send_log
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
