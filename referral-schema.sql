-- Referral program schema for Paradox of Acceptance
-- Run in Supabase SQL Editor before first deploy.
--
-- Tables:
--   referral_codes       — one unique 8-char alphanumeric code per user (wallet_address)
--   referral_conversions — tracks signups via referral link and when/if they converted to paid

-- ─── referral_codes ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referral_codes (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE,  -- wallet_address (lowercase)
  code       TEXT NOT NULL UNIQUE,  -- 8-char alphanumeric, e.g. "AB12CD34"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes (user_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code    ON referral_codes (code);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access referral_codes" ON referral_codes
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── referral_conversions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS referral_conversions (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code             TEXT NOT NULL,              -- referral code used
  referee_user_id  TEXT NOT NULL UNIQUE,       -- wallet_address of the person who signed up
                                               -- UNIQUE ensures one conversion record per referee
  converted_at     TIMESTAMPTZ,               -- when they completed trial and paid (NULL = pending)
  credited_at      TIMESTAMPTZ,               -- when the referrer received their Stripe credit (NULL = not yet credited)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_conversions_code     ON referral_conversions (code);
CREATE INDEX IF NOT EXISTS idx_referral_conversions_referee  ON referral_conversions (referee_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_conversions_credited ON referral_conversions (credited_at);

ALTER TABLE referral_conversions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access referral_conversions" ON referral_conversions
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
