-- Stripe subscriptions table for Paradox of Acceptance
-- Run in Supabase SQL Editor to enable fiat access alongside token-gating.
--
-- A row exists for every user who has initiated or held a Stripe subscription.
-- Status mirrors Stripe: 'active' | 'cancelled' | 'past_due'
-- Access is granted when status = 'active' and current_period_end > now().

CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address          TEXT NOT NULL UNIQUE,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'cancelled', 'past_due')),
  current_period_end      TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_wallet ON subscriptions (wallet_address);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub ON subscriptions (stripe_subscription_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Service role can read/write everything (webhooks, admin queries)
CREATE POLICY "Service role full access" ON subscriptions
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_subscriptions_updated_at();
