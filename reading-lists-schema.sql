-- Reading Lists schema for Paradox of Acceptance
-- Run in Supabase SQL Editor to enable curated reading paths.
--
-- reading_lists — admin-created collections (e.g. "Beginner", "Advanced")
-- reading_list_items — essays ordered within a list, with optional annotation

-- ─── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reading_lists (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  description      TEXT,
  cover_image_url  TEXT,          -- optional; falls back to first essay OG image
  display_order    INTEGER NOT NULL DEFAULT 0,
  published        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reading_list_items (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  list_id      UUID NOT NULL REFERENCES reading_lists(id) ON DELETE CASCADE,
  essay_slug   TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  annotation   TEXT,             -- optional note about why this essay is in the list
  UNIQUE (list_id, essay_slug)
);

CREATE INDEX IF NOT EXISTS idx_reading_lists_display_order ON reading_lists (display_order);
CREATE INDEX IF NOT EXISTS idx_reading_list_items_list_id  ON reading_list_items (list_id, position);
CREATE INDEX IF NOT EXISTS idx_reading_list_items_essay    ON reading_list_items (essay_slug);

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE reading_lists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_list_items ENABLE ROW LEVEL SECURITY;

-- Public can read published lists
CREATE POLICY "Public read published lists" ON reading_lists
  FOR SELECT USING (published = true OR auth.role() = 'service_role');

-- Service role full access (admin API uses service role key)
CREATE POLICY "Service role full access to lists" ON reading_lists
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Public can read items belonging to published lists
CREATE POLICY "Public read items of published lists" ON reading_list_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM reading_lists rl
      WHERE rl.id = reading_list_items.list_id
        AND (rl.published = true OR auth.role() = 'service_role')
    )
  );

-- Service role full access to items
CREATE POLICY "Service role full access to items" ON reading_list_items
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
