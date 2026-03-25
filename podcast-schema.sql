-- podcast-schema.sql
-- Podcast episodes table for paradoxofacceptance.xyz
-- Run in Supabase SQL Editor.
--
-- Tables:
--   podcast_episodes  — one row per published episode

-- ─── podcast_episodes ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS podcast_episodes (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  title            TEXT        NOT NULL,
  slug             TEXT        NOT NULL UNIQUE,
  description      TEXT,                      -- short excerpt shown in episode list
  show_notes       TEXT,                      -- markdown, full show notes on detail page
  audio_url        TEXT        NOT NULL,
  duration         INTEGER     NOT NULL DEFAULT 0,  -- seconds
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  season_number    INTEGER,
  episode_number   INTEGER,
  published        BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_slug
  ON podcast_episodes (slug);

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_feed
  ON podcast_episodes (published, published_at DESC)
  WHERE published = true;

ALTER TABLE podcast_episodes ENABLE ROW LEVEL SECURITY;

-- Public: read published episodes
CREATE POLICY "Public read published podcast_episodes" ON podcast_episodes
  FOR SELECT USING (published = true);

-- Service role: full access
CREATE POLICY "Service role full access podcast_episodes" ON podcast_episodes
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─── Seed data ────────────────────────────────────────────────────────────────
-- Placeholder audio URLs — replace with actual hosted MP3 links before launch.

INSERT INTO podcast_episodes
  (title, slug, description, show_notes, audio_url, duration,
   published_at, season_number, episode_number, published)
VALUES

(
  'What Mindfulness Actually Does (and Doesn''t)',
  'what-mindfulness-actually-does',
  'Most introductions to mindfulness skip the part where it gets uncomfortable. This episode covers what meditation actually does to attention, motivation, and the sense of self — and why that''s different from what the wellness industry suggests.',
  E'# What Mindfulness Actually Does (and Doesn''t)\n\n## Show Notes\n\nMindfulness is usually sold as a tool for relaxation and stress reduction. That''s not wrong, but it''s incomplete — and the incomplete picture misleads a lot of serious practitioners.\n\nIn this episode we work through three things mindfulness reliably does:\n\n1. **Interrupts automatic pilot.** You start noticing thoughts as thoughts rather than as facts. This is genuinely useful.\n2. **Reduces the urgency of unpleasant states.** Pain doesn''t disappear but its grip loosens.\n3. **Destabilizes the sense of a fixed, continuous self.** This is where things get interesting — and where most beginner resources stop.\n\nWe also cover what mindfulness *doesn''t* do: it doesn''t automatically produce insight, it doesn''t make decisions for you, and it doesn''t cure the underlying causes of suffering.\n\n## Key Ideas\n\n- The difference between *awareness of* an experience and *being absorbed by* it\n- Why the first weeks of practice often feel like things are getting worse\n- The relationship between clarity and discomfort\n\n## Further Reading\n\n- The Paradox of Acceptance essay\n- [Should You Get Into Mindfulness?](/mindfulness-essays/should-you-get-into-mindfulness/)',
  'https://media.paradoxofacceptance.xyz/podcast/s1e1-what-mindfulness-actually-does.mp3',
  1935,  -- 32:15
  '2026-02-10 09:00:00+00',
  1, 1, true
),

(
  'The Acceptance Paradox',
  'the-acceptance-paradox',
  'Accepting an experience fully — without agenda — is one of the strangest instructions you can give a person. This episode explains the paradox at the heart of mindfulness practice: the moment you try to accept something in order to feel better, you''ve already failed.',
  E'# The Acceptance Paradox\n\n## Show Notes\n\nThe paradox is this: genuine acceptance means accepting *this moment as it is*, including the discomfort, the resistance, and the part of you that wants things to be different. The moment you accept in order to get relief, you''ve introduced an agenda. That agenda is a subtle form of resistance.\n\nThis isn''t a trick or a word game. It points to something real about how attention works.\n\n## What We Cover\n\n- Why acceptance is not the same as resignation\n- The difference between *accepting* an experience and *getting comfortable with* one\n- What teachers mean when they say "let go" — and why that instruction so often backfires\n- Practical implications: what does non-agenda acceptance look like in a 20-minute sit?\n\n## The Key Distinction\n\nAcceptance-as-technique fails. Acceptance-as-orientation is what meditation is actually training. The difference is subtle but the implications are significant.\n\n## Further Reading\n\n- [The Paradox of Acceptance](/mindfulness-essays/the-paradox-of-acceptance/)\n- [The Avoidance Problem](/mindfulness-essays/the-avoidance-problem/)',
  'https://media.paradoxofacceptance.xyz/podcast/s1e2-the-acceptance-paradox.mp3',
  1720,  -- 28:40
  '2026-02-24 09:00:00+00',
  1, 2, true
),

(
  'Dosage: How Much Meditation Is Too Much?',
  'dosage-how-much-meditation',
  'Ten minutes a day, two hours, or a ten-day retreat — what''s the right amount? This episode looks at what we actually know about practice dosage, the signs you''re under- or over-meditating, and how to calibrate for your life.',
  E'# Dosage: How Much Meditation Is Too Much?\n\n## Show Notes\n\nThere''s no universal answer to how much you should meditate. But there are useful heuristics, and there are warning signs at both ends of the spectrum that most teachers don''t discuss.\n\n## What We Cover\n\n- The research on minimum effective dose (it''s lower than most apps suggest)\n- Signs you''re under-practicing: the "insight lag" problem\n- Signs you''re over-practicing: destabilization, depersonalization, what to do\n- How to design a practice schedule that fits a real life\n- The retreat question: when do intensive periods help vs. when do they destabilize?\n\n## The Destabilization Curve\n\nMore practice isn''t always better. There''s a curve. Early on, more practice accelerates clarity. At some point — different for everyone — it produces more disruption than integration can handle. Learning to recognize where you are on that curve is a core skill.\n\n## Practical Heuristics\n\n1. Can you function well and notice the effects of practice in daily life? You''re probably in range.\n2. Are you consistently agitated, anxious, or dissociated after sessions? Back off.\n3. Are you barely noticing any effect? You might need more — or a different technique.\n\n## Further Reading\n\n- [Dosage](/mindfulness-essays/dosage/) essay\n- The Honest Meditator course, Session 3',
  'https://media.paradoxofacceptance.xyz/podcast/s1e3-dosage.mp3',
  2480,  -- 41:20
  '2026-03-10 09:00:00+00',
  1, 3, true
),

(
  'When Meditation Makes Things Worse',
  'when-meditation-makes-things-worse',
  'For some practitioners, consistent meditation practice leads to increased anxiety, emotional flooding, or a disturbing loss of continuity. This isn''t failure. But it does require understanding what''s happening and what to do about it.',
  E'# When Meditation Makes Things Worse\n\n## Show Notes\n\nThis episode covers a topic most meditation teachers are reluctant to discuss: the cases where sustained practice produces adverse effects — not because something went wrong, but because practice is doing exactly what it does.\n\n## What We Cover\n\n- The spectrum of adverse meditation experiences (AMEs): from mild to serious\n- Why destabilization is sometimes a sign of progress, sometimes a sign to stop\n- Trauma and meditation: what practitioners with trauma histories need to know\n- The "spiritual emergency" concept — is it real?\n- When to step back, when to seek support, when to keep going\n\n## Who This Affects\n\nAdverse effects aren''t rare. Studies suggest meaningful percentages of meditators experience them. They''re just not talked about, because the wellness framing of mindfulness has no room for them.\n\n## What To Do\n\nThe protocol depends on the symptom. For most mild cases: reduce session length, favor open monitoring over focused attention, increase physical grounding practices. For persistent or severe symptoms: work with a teacher, consider a therapist familiar with contemplative practice.\n\n## Further Reading\n\n- Willoughby Britton''s research on adverse meditation experiences\n- The Cheetah House resources\n- [Practicing Honestly](/podcast/practicing-honestly/) (next episode)',
  'https://media.paradoxofacceptance.xyz/podcast/s1e4-when-meditation-makes-things-worse.mp3',
  2110,  -- 35:10
  '2026-03-17 09:00:00+00',
  1, 4, true
),

(
  'Practicing Honestly',
  'practicing-honestly',
  'The gap between what a meditation practice is supposed to do and what it actually does in your life is the most important diagnostic tool available to you. This episode is about using that gap — honestly.',
  E'# Practicing Honestly\n\n## Show Notes\n\nHonest practice means checking your actual experience against what you expect practice to produce. Most practitioners don''t do this. They measure their practice by how long they sat, not by whether sitting changed anything.\n\n## What We Cover\n\n- What "honest practice" means in concrete terms\n- The three questions to ask after every session\n- Why the gap between expectation and experience is information, not failure\n- How to build a feedback loop into practice\n- The difference between a good practice and a comfortable one\n\n## The Three Questions\n\n1. What happened during the session — as precisely as you can describe it?\n2. Did the quality of attention in daily life shift after the session?\n3. Is the overall direction of practice pointing toward less suffering, or more cleverly managed suffering?\n\n## The Honest Reckoning\n\nSome people have been meditating for years and their practice has become a sophisticated form of avoidance. The point of honest practice is to catch this before it calcifies.\n\n## Further Reading\n\n- The Honest Meditator course (Session 6: Practicing Honestly)\n- [The Cherry-Picking Problem](/mindfulness-essays/the-cherry-picking-problem/)',
  'https://media.paradoxofacceptance.xyz/podcast/s1e5-practicing-honestly.mp3',
  1795,  -- 29:55
  '2026-03-24 09:00:00+00',
  1, 5, true
),

(
  'The Transfer Problem',
  'the-transfer-problem',
  'Meditators get good at meditating. But does that skill transfer to the rest of life? This episode examines the transfer problem — why insight on the cushion doesn''t automatically become insight off it, and what actually bridges the gap.',
  E'# The Transfer Problem\n\n## Show Notes\n\nThe most common complaint from experienced meditators: "I can be present during a sit, but the moment something stressful happens in real life I''m reactive again." This is the transfer problem.\n\n## What We Cover\n\n- Why formal practice and informal practice train different things\n- The consolidation period: what happens in daily life that makes practice stick\n- Active transfer techniques: walking meditation, contemplative inquiry, micro-practices\n- The role of community and teacher in accelerating transfer\n- What transfer actually looks like when it''s working\n\n## The Core Insight\n\nFormal practice builds the capacity. Transfer requires deploying that capacity under actual conditions — with real stakes, real distraction, real aversion. You can''t shortcut this with more sitting.\n\n## Practical Implications\n\n1. Formal sessions should be complemented by a deliberate informal practice\n2. Hard emotional situations are training opportunities, not failures\n3. Reviewing difficult situations after the fact — with practice eyes — is as valuable as the sit\n\n## Further Reading\n\n- [The Transfer Problem](/mindfulness-essays/the-transfer-problem/) essay\n- The Honest Meditator course overview',
  'https://media.paradoxofacceptance.xyz/podcast/s1e6-the-transfer-problem.mp3',
  2310,  -- 38:30
  '2026-03-31 09:00:00+00',
  1, 6, true
);
