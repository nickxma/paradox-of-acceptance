-- video-embed-schema.sql
-- Extends poa_lessons to support embedded video (YouTube and Vimeo).
-- Run in Supabase SQL Editor after courses-schema.sql.
--
-- Changes:
--   1. poa_lessons gains video_url, video_position, video_embed_url,
--      video_platform, video_thumbnail_url columns
--   2. lesson_video_watches — per-user per-lesson video watch records
--      (tracks percent_watched; used to count toward lesson completion)

-- ─── Video columns on poa_lessons ─────────────────────────────────────────────

ALTER TABLE poa_lessons
  ADD COLUMN IF NOT EXISTS video_url            TEXT,
  ADD COLUMN IF NOT EXISTS video_position       TEXT
    CHECK (video_position IN ('top', 'bottom', 'inline')),
  ADD COLUMN IF NOT EXISTS video_embed_url      TEXT,
  ADD COLUMN IF NOT EXISTS video_platform       TEXT
    CHECK (video_platform IN ('youtube', 'vimeo')),
  ADD COLUMN IF NOT EXISTS video_thumbnail_url  TEXT;

-- ─── lesson_video_watches ─────────────────────────────────────────────────────
-- Records per-user per-lesson video watch events.
-- percent_watched: 0–100 (stored as the highest percent seen so far).
-- completed_at: set when percent_watched first reaches >= 90.

CREATE TABLE IF NOT EXISTS lesson_video_watches (
  user_id          UUID        NOT NULL,
  lesson_id        UUID        NOT NULL REFERENCES poa_lessons(id) ON DELETE CASCADE,
  percent_watched  INTEGER     NOT NULL DEFAULT 0,
  completed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_video_watches_user ON lesson_video_watches (user_id);

ALTER TABLE lesson_video_watches ENABLE ROW LEVEL SECURITY;

-- Users read their own watch records
CREATE POLICY "Users read own lesson_video_watches" ON lesson_video_watches
  FOR SELECT USING (auth.uid() = user_id);

-- Users insert their own watch records
CREATE POLICY "Users insert own lesson_video_watches" ON lesson_video_watches
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users update their own watch records
CREATE POLICY "Users update own lesson_video_watches" ON lesson_video_watches
  FOR UPDATE USING (auth.uid() = user_id);

-- Service role: full access
CREATE POLICY "Service role full access lesson_video_watches" ON lesson_video_watches
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
