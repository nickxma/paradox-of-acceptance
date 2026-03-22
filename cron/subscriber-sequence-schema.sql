-- subscriber_sequence_progress table — tracks newsletter welcome drip state
-- Part of OLU-488: 3-email newsletter subscriber welcome sequence.
-- Run in Supabase SQL Editor before first cron deploy.
--
-- Audience: people who subscribed via the website (may not have an app account).
-- Triggered: new Resend audience contact addition → tracked via subscribers.created_at.
--
-- Steps tracked:
--   0 — Welcome (immediate, sent within 24h of subscription)
--   3 — Day 3 practice prompt + Q&A invite
--   7 — Day 7 account creation + community invite

CREATE TABLE IF NOT EXISTS subscriber_sequence_progress (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- subscriber email (matches subscribers.email — no FK to avoid cross-schema issues)
  subscriber_id   TEXT NOT NULL,
  -- day number: 0, 3, or 7
  step            INTEGER NOT NULL CHECK (step IN (0, 3, 7)),
  -- Resend email id (for open tracking via webhook)
  resend_email_id TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at       TIMESTAMPTZ,

  -- idempotency: one row per subscriber per step
  UNIQUE (subscriber_id, step)
);

CREATE INDEX IF NOT EXISTS idx_sub_seq_step        ON subscriber_sequence_progress (step);
CREATE INDEX IF NOT EXISTS idx_sub_seq_subscriber  ON subscriber_sequence_progress (subscriber_id);
CREATE INDEX IF NOT EXISTS idx_sub_seq_resend      ON subscriber_sequence_progress (resend_email_id);

ALTER TABLE subscriber_sequence_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access subscriber_sequence_progress" ON subscriber_sequence_progress
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
