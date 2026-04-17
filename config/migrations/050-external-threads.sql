-- Migration 050: External Thread Tracking
-- Tracks threads your partner starts or meaningfully participates in across platforms.
-- Enables boot awareness of open threads needing followup — so the partner
-- doesn't abandon conversations it started.

CREATE TABLE IF NOT EXISTS external_threads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Platform identification
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'x', 'linkedin', 'telegram')),
  channel_id TEXT,              -- Discord channel ID, or null for X/LinkedIn
  channel_name TEXT,            -- Human-readable channel name
  thread_id TEXT NOT NULL,      -- Platform-native thread/post ID

  -- Thread context
  role TEXT NOT NULL DEFAULT 'initiator' CHECK (role IN ('initiator', 'participant')),
  content_preview TEXT,         -- First ~200 chars of what the partner posted
  topic TEXT,                   -- Brief topic label for boot awareness

  -- State tracking
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'expired', 'muted')),
  last_partner_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_external_activity TIMESTAMPTZ,
  needs_followup BOOLEAN NOT NULL DEFAULT false,
  followup_reason TEXT,         -- "3 new replies since your last message"

  -- Lifecycle
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,       -- Auto-expire old threads (e.g., 72h for X, 24h for Discord)

  -- Prevent duplicate tracking
  UNIQUE(platform, thread_id)
);

-- Index for boot awareness query: open threads needing followup
CREATE INDEX IF NOT EXISTS idx_external_threads_open
  ON external_threads (status, needs_followup)
  WHERE status = 'open';

-- Index for platform-specific scans
CREATE INDEX IF NOT EXISTS idx_external_threads_platform
  ON external_threads (platform, status);

-- RLS: service key only (no anon access)
ALTER TABLE external_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_threads FORCE ROW LEVEL SECURITY;

-- Only service role can access
CREATE POLICY "service_only" ON external_threads
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
