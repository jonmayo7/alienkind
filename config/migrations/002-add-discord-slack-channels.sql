-- ============================================================
-- MIGRATION 002: Channel Types — multi-platform conversation support
-- Adds channel values for terminal, telegram, discord, slack, heartbeat, nightly, web.
-- Each row in `conversations` is tagged with the channel it came from — enables
-- per-channel prompting, filtering, and trust-level routing.
-- ============================================================

-- Drop and recreate the channel CHECK constraint to include new channels
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN (
  'terminal',
  'telegram_dm',
  'telegram_group',
  'telegram_community',
  'heartbeat',
  'nightly',
  'web',
  'discord_dm',
  'discord_channel',
  'slack_dm',
  'slack_channel'
));
