-- subscriber_preferences table for Paradox of Acceptance
-- Tracks per-subscriber opt-in/out for each send category.
-- Run this in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS subscriber_preferences (
  subscriber_id TEXT PRIMARY KEY,         -- subscriber's email (lowercase)
  weekly_digest BOOLEAN NOT NULL DEFAULT true,
  newsletter    BOOLEAN NOT NULL DEFAULT true,
  course_updates BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Re-use the existing update_updated_at() trigger function (defined in subscribers schema)
CREATE TRIGGER subscriber_preferences_updated_at
  BEFORE UPDATE ON subscriber_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS: service role only
ALTER TABLE subscriber_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON subscriber_preferences
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
