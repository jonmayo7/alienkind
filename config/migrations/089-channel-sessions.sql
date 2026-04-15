-- Migration 089: Channel Sessions — persistent session state for listener channels
-- Enables Telegram, Discord, and War Room to maintain persistent Claude sessions
-- across messages instead of spawning fresh one-shot invocations.
--
-- Single source of truth for session state. Replaces file-based JSON session tracking
-- for listener channels (daemon keeps its own file-based state via session-manager.ts).

CREATE TABLE IF NOT EXISTS channel_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel TEXT NOT NULL,                    -- e.g., 'telegram_dm', 'war_room', 'discord_dm'
  session_id TEXT NOT NULL,                 -- Claude Code session UUID
  session_date TEXT NOT NULL,               -- YYYY-MM-DD for daily rotation
  message_count INTEGER DEFAULT 0,          -- messages processed in this session
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ DEFAULT now(),
  rotated_at TIMESTAMPTZ,                   -- when this session was retired
  active BOOLEAN DEFAULT true               -- false = rotated out, kept for history
);

-- Only one active session per channel at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_sessions_active
  ON channel_sessions (channel) WHERE active = true;

-- Lookup by channel (most common query)
CREATE INDEX IF NOT EXISTS idx_channel_sessions_channel
  ON channel_sessions (channel, active);

-- RLS: service role only (daemon/listeners use service role key)
ALTER TABLE channel_sessions ENABLE ROW LEVEL SECURITY;
