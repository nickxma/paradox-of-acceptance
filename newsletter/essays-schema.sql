-- essays table — scheduled essay publishing
-- Run in Supabase SQL Editor before using the essay scheduling feature.
--
-- published_at logic:
--   NULL          = draft (not scheduled, not visible)
--   future time   = scheduled (will publish at that time)
--   past time     = published (visible on site)
--
-- deployed_at: set by the hourly cron when static files (index, sitemap, feed)
--              are updated via the GitHub API. NULL means the essay is due for
--              deployment even if published_at has passed.

-- Depends on update_updated_at_col() from schema.sql (cron/schema.sql).
-- Ensure that function exists before running this.

-- ─── essays ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS essays (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  kicker       TEXT,           -- e.g. "Essay · Mindfulness & Motivation"
  description  TEXT,           -- excerpt shown in the index listing
  read_time    TEXT,           -- e.g. "~10 min read"
  path         TEXT NOT NULL,  -- URL path, e.g. /mindfulness-essays/when-to-quit/
  published_at TIMESTAMPTZ,    -- null = draft; future = scheduled; past = published
  deployed_at  TIMESTAMPTZ,    -- set when cron has updated the static site files
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_essays_published_at ON essays (published_at);
CREATE INDEX IF NOT EXISTS idx_essays_slug         ON essays (slug);

ALTER TABLE essays ENABLE ROW LEVEL SECURITY;

-- Only the service role (server-side code) can read or write essays.
CREATE POLICY "Service role full access essays" ON essays
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER essays_updated_at
  BEFORE UPDATE ON essays
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_col();

-- ─── Seed existing published essays ──────────────────────────────────────────
-- All five essays are already live; mark them published + deployed.

INSERT INTO essays (slug, title, kicker, description, read_time, path, published_at, deployed_at) VALUES
  (
    'paradox-of-acceptance',
    'The Paradox of Acceptance',
    'Essay · Mindfulness & Motivation',
    'What happens to ambition, urgency, and deferred gratification when mindfulness becomes very good? The better we get at meeting whatever arises, the less obvious it becomes why we should sacrifice now for a later state we also expect to be able to accept.',
    '~15 min read · Interactive',
    '/mindfulness-essays/paradox-of-acceptance/',
    NOW(), NOW()
  ),
  (
    'should-you-get-into-mindfulness',
    'Should You Get Into Mindfulness?',
    'Essay · Who Mindfulness Is For',
    'The case for treating meditation like medicine, not vitamins — who it helps, when it doesn''t, and what nobody in the mindfulness world will tell you about dosage.',
    '~10 min read',
    '/mindfulness-essays/should-you-get-into-mindfulness/',
    NOW(), NOW()
  ),
  (
    'the-cherry-picking-problem',
    'The Cherry-Picking Problem',
    'Essay · Self & Motivation',
    'You can''t be an atheist about every god except one. The neurotic self and the motivated self are the same process — and dissolving one without touching the other is harder than it looks.',
    '~8 min read',
    '/mindfulness-essays/the-cherry-picking-problem/',
    NOW(), NOW()
  ),
  (
    'the-avoidance-problem',
    'The Avoidance Problem',
    'Essay · Practice & Honesty',
    'Skilled meditators can use practice to metabolize difficult feelings before asking what they mean — not equanimity, but avoidance with better posture. Mindfulness can make you comfortable in situations you should change.',
    '~7 min read',
    '/mindfulness-essays/the-avoidance-problem/',
    NOW(), NOW()
  ),
  (
    'when-to-quit',
    'When to Quit',
    'Essay · Practice & Exit',
    'The mindfulness world has rich language for starting and deepening — and almost none for stopping. This essay names the legitimate exit conditions that almost no teacher will state clearly.',
    '~7 min read',
    '/mindfulness-essays/when-to-quit/',
    NOW(), NOW()
  )
ON CONFLICT (slug) DO NOTHING;
