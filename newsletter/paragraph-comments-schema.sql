-- paragraph-comments-schema.sql
-- Extends draft_feedback to support inline paragraph comments, commenter identity,
-- admin replies, and resolved state.
-- Run in Supabase SQL Editor after essay-preview-schema.sql.

ALTER TABLE draft_feedback
  ADD COLUMN IF NOT EXISTS paragraph_index   INT,
  ADD COLUMN IF NOT EXISTS commenter_name    TEXT,
  ADD COLUMN IF NOT EXISTS commenter_email   TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_id       UUID REFERENCES draft_feedback(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_admin_reply    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resolved          BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_draft_feedback_reply_to ON draft_feedback (reply_to_id);
