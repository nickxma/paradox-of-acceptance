-- content-calendar-schema.sql
-- Scheduled publishing for paradoxofacceptance.xyz
-- OLU-780: PoA content calendar
--
-- Run in Supabase SQL Editor.
--
-- Changes:
--   poa_courses  — add scheduled_publish_at (TIMESTAMPTZ, nullable)
--   poa_lessons  — add scheduled_publish_at (TIMESTAMPTZ, nullable)
--
-- Scheduling semantics:
--   scheduled_publish_at = NULL   → no scheduled publish; behave as before
--   scheduled_publish_at = future → will auto-publish when cron next fires
--   scheduled_publish_at = past   → cron fires and sets published=true (courses)
--                                   or published_at=now() (lessons)
--   Cron clears scheduled_publish_at after publishing so it doesn't re-fire.

-- ─── poa_courses: add scheduled_publish_at ────────────────────────────────────

ALTER TABLE poa_courses
  ADD COLUMN IF NOT EXISTS scheduled_publish_at TIMESTAMPTZ;

-- Efficient cron scan: only rows that need processing
CREATE INDEX IF NOT EXISTS idx_poa_courses_scheduled
  ON poa_courses (scheduled_publish_at)
  WHERE scheduled_publish_at IS NOT NULL AND published = false AND deleted_at IS NULL;

-- ─── poa_lessons: add scheduled_publish_at ───────────────────────────────────
-- poa_lessons already has published_at (null=draft, past=published).
-- scheduled_publish_at is a *separate* scheduling intent column — the cron
-- reads it and, when the time arrives, sets published_at = scheduled_publish_at
-- and clears scheduled_publish_at.

ALTER TABLE poa_lessons
  ADD COLUMN IF NOT EXISTS scheduled_publish_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_poa_lessons_scheduled
  ON poa_lessons (scheduled_publish_at)
  WHERE scheduled_publish_at IS NOT NULL AND published_at IS NULL;
