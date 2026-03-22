-- Weekly digest cron — Supabase schema
-- Run in Supabase SQL Editor before first deploy.
--
-- Tables:
--   community_posts  — user-submitted discussion threads
--   community_qa     — Q&A pairs (questions from community, answers from editor)
--   email_sends      — log of all automated digest sends

-- ─── community_posts ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS community_posts (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  excerpt      TEXT,
  body         TEXT,
  author_email TEXT,
  reply_count  INTEGER NOT NULL DEFAULT 0,
  published    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_posts_created  ON community_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_replies  ON community_posts (reply_count DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_slug     ON community_posts (slug);

ALTER TABLE community_posts ENABLE ROW LEVEL SECURITY;

-- Public read of published posts
CREATE POLICY "Public read published posts" ON community_posts
  FOR SELECT USING (published = true);

-- Service role full access
CREATE POLICY "Service role full access posts" ON community_posts
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_col()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER community_posts_updated_at
  BEFORE UPDATE ON community_posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_col();

-- ─── community_qa ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS community_qa (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT,         -- null = open question, no answer yet
  published  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_community_qa_created ON community_qa (created_at DESC);

ALTER TABLE community_qa ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read published qa" ON community_qa
  FOR SELECT USING (published = true);

CREATE POLICY "Service role full access qa" ON community_qa
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER community_qa_updated_at
  BEFORE UPDATE ON community_qa
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_col();

-- ─── email_sends ──────────────────────────────────────────────────────────────
-- General-purpose log for all automated email sends (digests, etc.)
-- Note: newsletter_sends (in newsletter/) tracks manual broadcast sends separately.

CREATE TABLE IF NOT EXISTS email_sends (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type             TEXT NOT NULL,          -- 'weekly_digest' | 'welcome' | etc.
  subject          TEXT NOT NULL,
  broadcast_id     TEXT,                   -- Resend broadcast ID
  recipient_count  INTEGER NOT NULL DEFAULT 0,
  post_count       INTEGER NOT NULL DEFAULT 0,
  qa_count         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  error            TEXT,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_sends_type    ON email_sends (type);
CREATE INDEX IF NOT EXISTS idx_email_sends_sent_at ON email_sends (sent_at DESC);

ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access email_sends" ON email_sends
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
