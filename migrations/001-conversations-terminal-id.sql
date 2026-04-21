-- Migration 001: Add terminal_id column to conversations table
--
-- Surfaced by the Conn × Kael bench (2026-04-20):
-- `scripts/hooks/log-conversation.ts` writes terminal_id as a first-class
-- column, but the conversations table schema as shipped (and as forkers
-- reverse-engineer from the code) does not include it. Without this
-- migration, every conversation-log write from the hook either fails
-- silently (column missing) or succeeds-but-loses-terminal-attribution
-- (depending on the forker's schema enforcement).
--
-- Credit: Rory Teehan + Conn for surfacing this as a blocker while
-- running the bench against AlienKind. They patched locally to
-- complete the benchmark; this migration lands the fix upstream.
--
-- Safe to run multiple times — IF NOT EXISTS guards both the column
-- and the index. Also safe on clones that already ran an equivalent
-- patch locally (the column add is a no-op if already present).

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS terminal_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_terminal_id
  ON conversations(terminal_id);

-- Forkers: if your conversations table doesn't exist yet, this migration
-- is a no-op (the ALTER fails harmlessly and no index gets created).
-- The broader schema bootstrap (CREATE TABLE conversations + related
-- tables) is tracked as a separate follow-up — see GAPS.md for the
-- schema-bootstrap work.
