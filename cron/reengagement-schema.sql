-- Re-engagement email campaign — Supabase schema migration
-- Part of OLU-454: 7-day inactivity trigger for lapsed users.
-- Run in Supabase SQL Editor before first cron deploy.
--
-- Adds to subscribers table:
--   has_received_reengagement_email  — idempotency gate (reset on click)
--   reengagement_sent_at             — timestamp of last re-engagement send
--   last_active_at                   — last time this subscriber did anything on site
--   last_activity_type               — what they last did: 'qa' | 'community' | 'course' | null

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS has_received_reengagement_email BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reengagement_sent_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_active_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_activity_type              TEXT CHECK (last_activity_type IN ('qa', 'community', 'course'));

-- Index: cron job queries this every day — needs to be fast
CREATE INDEX IF NOT EXISTS idx_subscribers_reengagement
  ON subscribers (has_received_reengagement_email, last_active_at)
  WHERE status = 'active';
