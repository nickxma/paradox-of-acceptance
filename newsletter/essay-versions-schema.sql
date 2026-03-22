-- essay-versions-schema.sql
-- Version history for essay content.
-- Run in Supabase SQL Editor after essays-schema.sql.

-- ─── Extend essays table ─────────────────────────────────────────────────────
-- Add content fields that are tracked in version history.

ALTER TABLE essays
  ADD COLUMN IF NOT EXISTS body_markdown    TEXT,
  ADD COLUMN IF NOT EXISTS meta_description TEXT,
  ADD COLUMN IF NOT EXISTS changed_by       TEXT;

-- ─── essay_versions ──────────────────────────────────────────────────────────
-- Full snapshot of essay content at each save point.
-- Stores complete snapshots (not diffs) — disk is cheap, retrieval is simple.

CREATE TABLE IF NOT EXISTS essay_versions (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  essay_slug       TEXT        NOT NULL REFERENCES essays(slug) ON DELETE CASCADE,
  body_markdown    TEXT,
  title            TEXT,
  meta_description TEXT,
  changed_by       TEXT,
  change_summary   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_essay_versions_slug_created
  ON essay_versions (essay_slug, created_at DESC);

ALTER TABLE essay_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access essay_versions" ON essay_versions
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
