-- onboarding_sequences table — tracks per-subscriber drip email state
-- Part of OLU-411: 7-day onboarding email sequence.
-- Run in Supabase SQL Editor before first cron deploy.
--
-- Steps tracked: 1, 3, 5, 7 (day numbers).
-- Day 0 (welcome) is handled by the subscription flow (OLU-109).

CREATE TABLE IF NOT EXISTS onboarding_sequences (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- subscriber email (matches subscribers.email — no FK to avoid cross-schema issues)
  subscriber_id TEXT NOT NULL,
  -- day number: 1, 3, 5, or 7
  step          INTEGER NOT NULL CHECK (step IN (1, 3, 5, 7)),
  -- Resend email id (for open tracking via webhook)
  resend_email_id TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at     TIMESTAMPTZ,

  -- idempotency: one row per subscriber per step
  UNIQUE (subscriber_id, step)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_step          ON onboarding_sequences (step);
CREATE INDEX IF NOT EXISTS idx_onboarding_subscriber    ON onboarding_sequences (subscriber_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_resend_email  ON onboarding_sequences (resend_email_id);

ALTER TABLE onboarding_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access onboarding_sequences" ON onboarding_sequences
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
