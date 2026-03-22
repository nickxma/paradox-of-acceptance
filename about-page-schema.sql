-- About page content table for paradoxofacceptance.xyz
-- Single-row table (upserted on save). Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS about_page (
  id           UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  photo_url    TEXT,
  tagline      TEXT    NOT NULL DEFAULT '',
  bio_markdown TEXT    NOT NULL DEFAULT '',
  twitter_url  TEXT,
  linkedin_url TEXT,
  contact_email TEXT,
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION update_about_page_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER about_page_updated_at
  BEFORE UPDATE ON about_page
  FOR EACH ROW
  EXECUTE FUNCTION update_about_page_updated_at();

-- RLS: lock down write access
ALTER TABLE about_page ENABLE ROW LEVEL SECURITY;

-- Public read (GET /api/about is unauthenticated)
CREATE POLICY "Public read about_page" ON about_page
  FOR SELECT USING (true);

-- Only service role can insert/update/delete
CREATE POLICY "Service role full access about_page" ON about_page
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Supabase Storage bucket for about page photos
-- Run this if you want to enable photo upload via admin:
--
-- insert into storage.buckets (id, name, public)
-- values ('about', 'about', true)
-- on conflict (id) do nothing;
--
-- create policy "Public read about photos" on storage.objects
--   for select using (bucket_id = 'about');
--
-- create policy "Service role write about photos" on storage.objects
--   for all using (bucket_id = 'about' and auth.role() = 'service_role')
--   with check (bucket_id = 'about' and auth.role() = 'service_role');
