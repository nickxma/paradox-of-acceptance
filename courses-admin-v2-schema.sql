-- courses-admin-v2-schema.sql
-- Extends the course platform schema for full admin authoring capabilities.
-- Run in Supabase SQL Editor after courses-schema.sql.
--
-- Changes:
--   1. Soft-delete support on poa_courses (deleted_at column)
--   2. audit_log table — records every admin mutation

-- ─── Soft-delete: poa_courses ─────────────────────────────────────────────────

ALTER TABLE poa_courses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Index to speed up the common "not deleted" filter
CREATE INDEX IF NOT EXISTS idx_poa_courses_not_deleted
  ON poa_courses (id) WHERE deleted_at IS NULL;

-- Update public read policy to exclude soft-deleted rows
DROP POLICY IF EXISTS "Public read published poa_courses" ON poa_courses;
CREATE POLICY "Public read published poa_courses" ON poa_courses
  FOR SELECT USING (published = true AND deleted_at IS NULL);

-- ─── audit_log ────────────────────────────────────────────────────────────────
-- Records every admin write operation on courses and lessons.
-- action values: create | update | delete | publish | unpublish |
--                duplicate | cover_upload | reorder

CREATE TABLE IF NOT EXISTS audit_log (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name TEXT        NOT NULL,
  row_id     TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  actor      TEXT        NOT NULL DEFAULT 'admin',
  changes    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_row ON audit_log (table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write audit logs
CREATE POLICY "Service role full access audit_log" ON audit_log
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
