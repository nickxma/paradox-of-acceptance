-- courses-schema.sql
-- Course platform for paradoxofacceptance.xyz
-- Run in Supabase SQL Editor.
--
-- Tables:
--   poa_courses         — course catalog
--   poa_lessons         — lessons within a course (ordered, markdown body)
--   course_enrollments  — per-user enrollment records
--   lesson_completions  — per-user lesson completion records
--   user_reputation     — running reputation points per user
--   user_badges         — badges earned by users (e.g. course completion)

-- ─── poa_courses ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS poa_courses (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  title            TEXT        NOT NULL,
  description      TEXT,
  slug             TEXT        NOT NULL UNIQUE,
  published        BOOLEAN     NOT NULL DEFAULT false,
  cover_image_url  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poa_courses_slug ON poa_courses (slug);
CREATE INDEX IF NOT EXISTS idx_poa_courses_published ON poa_courses (published) WHERE published = true;

ALTER TABLE poa_courses ENABLE ROW LEVEL SECURITY;

-- Public: read published courses
CREATE POLICY "Public read published poa_courses" ON poa_courses
  FOR SELECT USING (published = true);

-- Service role: full access
CREATE POLICY "Service role full access poa_courses" ON poa_courses
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── poa_lessons ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS poa_lessons (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id         UUID        NOT NULL REFERENCES poa_courses(id) ON DELETE CASCADE,
  title             TEXT        NOT NULL,
  body              TEXT,                   -- markdown
  position          INTEGER     NOT NULL DEFAULT 0,
  estimated_minutes INTEGER,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poa_lessons_course_id ON poa_lessons (course_id);
CREATE INDEX IF NOT EXISTS idx_poa_lessons_position ON poa_lessons (course_id, position);

ALTER TABLE poa_lessons ENABLE ROW LEVEL SECURITY;

-- Public: read lessons for published courses
CREATE POLICY "Public read poa_lessons for published courses" ON poa_lessons
  FOR SELECT USING (
    published_at IS NOT NULL
    AND published_at <= now()
    AND EXISTS (
      SELECT 1 FROM poa_courses c WHERE c.id = poa_lessons.course_id AND c.published = true
    )
  );

-- Service role: full access
CREATE POLICY "Service role full access poa_lessons" ON poa_lessons
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── course_enrollments ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS course_enrollments (
  user_id     UUID        NOT NULL,
  course_id   UUID        NOT NULL REFERENCES poa_courses(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_course_enrollments_user ON course_enrollments (user_id);

ALTER TABLE course_enrollments ENABLE ROW LEVEL SECURITY;

-- Users read their own enrollments
CREATE POLICY "Users read own enrollments" ON course_enrollments
  FOR SELECT USING (auth.uid() = user_id);

-- Users insert their own enrollments
CREATE POLICY "Users insert own enrollments" ON course_enrollments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Service role: full access
CREATE POLICY "Service role full access course_enrollments" ON course_enrollments
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── lesson_completions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lesson_completions (
  user_id      UUID        NOT NULL,
  lesson_id    UUID        NOT NULL REFERENCES poa_lessons(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_completions_user ON lesson_completions (user_id);

ALTER TABLE lesson_completions ENABLE ROW LEVEL SECURITY;

-- Users read their own completions
CREATE POLICY "Users read own lesson_completions" ON lesson_completions
  FOR SELECT USING (auth.uid() = user_id);

-- Users insert their own completions
CREATE POLICY "Users insert own lesson_completions" ON lesson_completions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Service role: full access
CREATE POLICY "Service role full access lesson_completions" ON lesson_completions
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── user_reputation ──────────────────────────────────────────────────────────
-- Running point total per user. Incremented by server-side triggers / API.

CREATE TABLE IF NOT EXISTS user_reputation (
  user_id    UUID        PRIMARY KEY,
  points     INTEGER     NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_reputation ENABLE ROW LEVEL SECURITY;

-- Users read their own reputation
CREATE POLICY "Users read own reputation" ON user_reputation
  FOR SELECT USING (auth.uid() = user_id);

-- Service role: full access
CREATE POLICY "Service role full access user_reputation" ON user_reputation
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── user_badges ──────────────────────────────────────────────────────────────
-- badge_key examples: 'course_complete:{slug}', 'first_lesson', etc.

CREATE TABLE IF NOT EXISTS user_badges (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID        NOT NULL,
  badge_key  TEXT        NOT NULL,
  earned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, badge_key)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges (user_id);

ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;

-- Users read their own badges
CREATE POLICY "Users read own badges" ON user_badges
  FOR SELECT USING (auth.uid() = user_id);

-- Service role: full access
CREATE POLICY "Service role full access user_badges" ON user_badges
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── Seed: The Honest Meditator ───────────────────────────────────────────────
-- Insert the existing course so static pages continue to work.
-- Adjust or remove if you prefer to insert via the admin API.

INSERT INTO poa_courses (title, description, slug, published, created_at)
VALUES (
  'The Honest Meditator',
  'Six sessions on what meditation actually does to motivation, urgency, and felt stakes — including the parts few teachers mention.',
  'the-honest-meditator',
  true,
  now()
)
ON CONFLICT (slug) DO NOTHING;
