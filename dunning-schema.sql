-- Stripe dunning / grace-period schema
-- Run in Supabase SQL Editor after stripe-schema.sql.
--
-- Changes:
--   1. Add grace_period_end column to subscriptions
--      Set when invoice.payment_failed; cleared on recovery.
--      Access check grants Pro during grace period (status=past_due AND grace_period_end > now()).
--   2. Add dunning_emails table for idempotent email scheduling
--      Tracks day-0, day-3, and day-7 emails per subscription.

-- ─── subscriptions.grace_period_end ──────────────────────────────────────────

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS grace_period_end TIMESTAMPTZ;

-- ─── dunning_emails ───────────────────────────────────────────────────────────
-- One row per scheduled dunning email per subscription.
-- day: 0 = immediate failure notice, 3 = 4-days-left reminder, 7 = final notice + downgrade.
-- status: 'pending' | 'sent' | 'cancelled'
-- Unique constraint on (stripe_subscription_id, day) prevents duplicate schedule entries.

CREATE TABLE IF NOT EXISTS dunning_emails (
  id                     UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  stripe_subscription_id TEXT         NOT NULL,
  customer_email         TEXT         NOT NULL,
  day                    INTEGER      NOT NULL CHECK (day IN (0, 3, 7)),
  scheduled_at           TIMESTAMPTZ  NOT NULL,
  sent_at                TIMESTAMPTZ,
  status                 TEXT         NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_id, day)
);

CREATE INDEX IF NOT EXISTS idx_dunning_emails_sub
  ON dunning_emails (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_dunning_emails_pending
  ON dunning_emails (status, scheduled_at)
  WHERE status = 'pending';

ALTER TABLE dunning_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access dunning_emails" ON dunning_emails
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
