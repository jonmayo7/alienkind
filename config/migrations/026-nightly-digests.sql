-- Migration 026: Nightly digest persistence (AAR Phase 4 gap fix)
-- Captures every nightly digest for learning and reference.

CREATE TABLE IF NOT EXISTS nightly_digests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest_date date NOT NULL,
  sections jsonb NOT NULL DEFAULT '{}',
  telegram_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nightly_digests_date
  ON nightly_digests (digest_date);

CREATE INDEX IF NOT EXISTS idx_nightly_digests_created
  ON nightly_digests (created_at DESC);
