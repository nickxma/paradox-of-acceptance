-- essay-preview-schema.sql
-- Private preview links for unpublished essay drafts.
-- Run in Supabase SQL Editor before using the preview link feature.

-- ─── essay_preview_tokens ────────────────────────────────────────────────────
-- One row per essay. Rotating (POST) replaces the existing row. Revoking deletes it.

CREATE TABLE IF NOT EXISTS essay_preview_tokens (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  essay_slug   TEXT        NOT NULL REFERENCES essays(slug) ON DELETE CASCADE,
  token        TEXT        NOT NULL,          -- full JWT (for DB-side lookup and revocation)
  viewer_hint  TEXT,                          -- optional display name shown in the preview banner
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_essay_preview_tokens_slug UNIQUE (essay_slug)
);

ALTER TABLE essay_preview_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access essay_preview_tokens" ON essay_preview_tokens
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── draft_feedback ──────────────────────────────────────────────────────────
-- Comments left by preview recipients via the feedback widget.

CREATE TABLE IF NOT EXISTS draft_feedback (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  essay_slug   TEXT        NOT NULL,
  viewer_hint  TEXT,                          -- from token, identifies which share link was used
  comment      TEXT        NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_draft_feedback_essay_slug ON draft_feedback (essay_slug);

ALTER TABLE draft_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access draft_feedback" ON draft_feedback
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
