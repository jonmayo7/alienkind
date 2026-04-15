-- ============================================================
-- MIGRATION 001: Conversations Table
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/[SUPABASE_PROJECT_ID]/sql/new
-- Date: 2026-02-18
-- ============================================================

-- Cross-channel message log. Every message across all interfaces.
-- Scalable: private (DM/terminal), group (Group), public (community/web).
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN (
    'terminal',
    'telegram_dm',
    'telegram_group',
    'telegram_community',
    'heartbeat',
    'nightly',
    'web'
  )),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'group', 'public')),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_sender ON conversations(sender);
CREATE INDEX IF NOT EXISTS idx_conversations_visibility ON conversations(visibility);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_content_search ON conversations USING gin(to_tsvector('english', content));

-- RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON conversations FOR ALL USING (true);
