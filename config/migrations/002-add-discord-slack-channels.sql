-- ============================================================
-- MIGRATION 002: Add Discord + Slack Channels to Conversations
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/[SUPABASE_PROJECT_ID]/sql/new
-- Date: 2026-02-18
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
