-- Session Notes — Paradox of Acceptance
-- Run this in Supabase SQL Editor (project: jyxwnfgcqgiqxjdlypvr)
--
-- Creates a private per-user note for each course session.
-- RLS ensures users can only access their own notes.

CREATE TABLE IF NOT EXISTS session_notes (
  user_id    UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT         NOT NULL,  -- e.g., "the-honest-meditator-1"
  content    TEXT         NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);

-- Index for efficient per-user bulk queries
CREATE INDEX IF NOT EXISTS idx_session_notes_user ON session_notes (user_id);

-- Row-level security: users can only read and write their own notes
ALTER TABLE session_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their notes" ON session_notes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
