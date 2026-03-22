-- Essay Reading Tracker — Paradox of Acceptance
-- Run this in Supabase SQL Editor (project: jyxwnfgcqgiqxjdlypvr)
--
-- Tracks when readers spend 30+ seconds on an essay.
-- Supports both authenticated users (by user_id) and anonymous readers
-- (by session_id), with server-side merge on first login.
-- Powers reading streaks separate from the course streak (see OLU-395).

-- ─── essay_reads ─────────────────────────────────────────────────────────────
-- One row per (user OR session) per essay per calendar day.
-- read_duration_seconds captures how long they actually stayed.

CREATE TABLE IF NOT EXISTS essay_reads (
  id                    UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id            TEXT,        -- anonymous reader fingerprint (localStorage UUID)
  essay_slug            TEXT         NOT NULL,
  read_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  read_duration_seconds INT          NOT NULL DEFAULT 30,
  CONSTRAINT chk_reader CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);

-- Prevent double-counting: one read per reader per essay per calendar day
CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_reads_user_slug_day
  ON essay_reads (user_id, essay_slug, (read_at::date))
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_essay_reads_session_slug_day
  ON essay_reads (session_id, essay_slug, (read_at::date))
  WHERE session_id IS NOT NULL AND user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_essay_reads_user ON essay_reads (user_id);
CREATE INDEX IF NOT EXISTS idx_essay_reads_session ON essay_reads (session_id);
CREATE INDEX IF NOT EXISTS idx_essay_reads_slug ON essay_reads (essay_slug);

-- RLS: authenticated users can read their own rows; anon reads via service role only
ALTER TABLE essay_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own essay reads" ON essay_reads
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users insert own essay reads" ON essay_reads
  FOR INSERT WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- ─── reading_streaks ─────────────────────────────────────────────────────────
-- One row per authenticated user; updated atomically on each new daily read.
-- Streak logic mirrors OLU-395 but keyed to essay reads, not course activity.

CREATE TABLE IF NOT EXISTS reading_streaks (
  user_id        UUID        NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  current_streak INT         NOT NULL DEFAULT 0,
  longest_streak INT         NOT NULL DEFAULT 0,
  last_read_date DATE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reading_streaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own reading streak" ON reading_streaks
  FOR SELECT USING (auth.uid() = user_id);
