-- Twitter/X auto-post integration schema
-- Run in Supabase SQL Editor

-- 1. Add tweet_id column to essays (stores the posted tweet ID, null if not yet tweeted)
ALTER TABLE essays ADD COLUMN IF NOT EXISTS tweet_id TEXT DEFAULT NULL;

-- 2. Add post_to_twitter flag (default true — new essays auto-tweet on publish)
ALTER TABLE essays ADD COLUMN IF NOT EXISTS post_to_twitter BOOLEAN NOT NULL DEFAULT TRUE;

-- 3. Social post error log (non-fatal tweet failures are recorded here)
CREATE TABLE IF NOT EXISTS social_post_errors (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  essay_slug  TEXT        NOT NULL,
  platform    TEXT        NOT NULL DEFAULT 'twitter',
  error_msg   TEXT        NOT NULL,
  error_detail JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for looking up errors by essay
CREATE INDEX IF NOT EXISTS social_post_errors_slug_idx ON social_post_errors (essay_slug);
