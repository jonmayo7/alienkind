-- Migration 003: Add partner_response column to learning_ledger
--
-- Surfaced by the 2026-04-20 Conn × Kael bench: scripts/lib/nightly/
-- analysis.ts queries a `partner_response` column for correction context
-- ("what did the partner say immediately before the correction?"), but
-- the column was never part of the schema AlienKind shipped. Fresh
-- clones running nightly analysis hit "column does not exist" errors or
-- silent empty rows depending on forker schema enforcement.
--
-- Context: learning_ledger accumulates human→partner corrections. Each
-- row captures pattern_name, correction_text, severity, etc. The
-- partner_response field stores what the partner said right before the
-- correction fired — the richer context used by should_have synthesis
-- to generate behavioral directives.
--
-- Safe to run multiple times — IF NOT EXISTS on the column add.
--
-- Note: this migration only adds the single column. The broader schema
-- bootstrap (CREATE TABLE learning_ledger + related tables) is a
-- separate concern and tracked in GAPS.md. Forkers whose schema doesn't
-- yet have learning_ledger will see the ALTER succeed as a no-op (the
-- column add skips silently when the table is absent in some Postgres
-- setups; on strict setups the migration runner should surface the
-- missing-table error as a bootstrap prompt).

ALTER TABLE learning_ledger
  ADD COLUMN IF NOT EXISTS partner_response TEXT;
