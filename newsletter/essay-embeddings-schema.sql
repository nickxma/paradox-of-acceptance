-- essay-embeddings-schema.sql
-- Related essays feature: vector embeddings, cache, and OpenAI usage logging.
--
-- Run in Supabase SQL Editor in order:
--   1. essay-embeddings-schema.sql (this file)
--
-- Depends on:
--   - essays table (essays-schema.sql)
--   - pgvector extension (enabled for OLU-315 semantic cache)
--   - update_updated_at_col() function (cron/schema.sql)

-- ─── Enable pgvector (idempotent) ─────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Add tags column to essays ────────────────────────────────────────────────

ALTER TABLE essays ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- Seed tags for existing five essays
UPDATE essays SET tags = ARRAY['mindfulness','motivation','acceptance','practice']
  WHERE slug = 'paradox-of-acceptance';
UPDATE essays SET tags = ARRAY['mindfulness','beginners','practice','mental-health']
  WHERE slug = 'should-you-get-into-mindfulness';
UPDATE essays SET tags = ARRAY['mindfulness','self','motivation','practice']
  WHERE slug = 'the-cherry-picking-problem';
UPDATE essays SET tags = ARRAY['mindfulness','practice','avoidance','honesty']
  WHERE slug = 'the-avoidance-problem';
UPDATE essays SET tags = ARRAY['mindfulness','practice','stopping']
  WHERE slug = 'when-to-quit';

-- ─── essay_embeddings ─────────────────────────────────────────────────────────
-- Stores the text-embedding-3-small vector (1536-dim) for each published essay.
-- Regenerated whenever the essay body changes.

CREATE TABLE IF NOT EXISTS essay_embeddings (
  essay_slug   TEXT NOT NULL PRIMARY KEY REFERENCES essays(slug) ON DELETE CASCADE,
  embedding    vector(1536) NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE essay_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access essay_embeddings" ON essay_embeddings
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── related_essays_cache ─────────────────────────────────────────────────────
-- Caches the top-N related essays per slug. TTL enforced application-side (24h).

CREATE TABLE IF NOT EXISTS related_essays_cache (
  slug         TEXT NOT NULL PRIMARY KEY REFERENCES essays(slug) ON DELETE CASCADE,
  related      JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE related_essays_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access related_essays_cache" ON related_essays_cache
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── openai_usage ─────────────────────────────────────────────────────────────
-- Logs every OpenAI API call for cost tracking (OLU-369).

CREATE TABLE IF NOT EXISTS openai_usage (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  model             TEXT        NOT NULL,
  operation         TEXT        NOT NULL, -- e.g. 'essay_embedding', 'semantic_cache'
  prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
  completion_tokens INTEGER     NOT NULL DEFAULT 0,
  total_tokens      INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE openai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access openai_usage" ON openai_usage
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── find_related_essays RPC ──────────────────────────────────────────────────
-- Returns top N most similar published essays (excluding self) using cosine
-- similarity via pgvector. Called by server.ts for the /api/essays/:slug/related
-- endpoint when embeddings exist.

CREATE OR REPLACE FUNCTION find_related_essays(p_slug text, p_limit int DEFAULT 4)
RETURNS TABLE(
  slug        text,
  title       text,
  description text,
  kicker      text,
  read_time   text,
  path        text,
  tags        text[],
  similarity  float
) LANGUAGE sql STABLE AS $$
  SELECT
    e.slug,
    e.title,
    e.description,
    e.kicker,
    e.read_time,
    e.path,
    e.tags,
    1 - (ee.embedding <=> src.embedding) AS similarity
  FROM essay_embeddings ee
  JOIN essays e ON ee.essay_slug = e.slug
  CROSS JOIN (
    SELECT embedding FROM essay_embeddings WHERE essay_slug = p_slug
  ) src
  WHERE e.slug != p_slug
    AND e.published_at IS NOT NULL
    AND e.published_at <= now()
  ORDER BY ee.embedding <=> src.embedding
  LIMIT p_limit;
$$;
