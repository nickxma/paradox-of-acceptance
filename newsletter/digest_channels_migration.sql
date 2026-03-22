-- digest_channels migration for subscriber_preferences
-- Add per-subscriber channel filter for the weekly digest.
--
-- digest_channels TEXT[] — array of channel slugs to include in the weekly digest.
-- NULL (default) = all channels. Empty array {} also falls back to all channels.
--
-- Run in Supabase SQL Editor.

ALTER TABLE subscriber_preferences
  ADD COLUMN IF NOT EXISTS digest_channels TEXT[] DEFAULT NULL;
