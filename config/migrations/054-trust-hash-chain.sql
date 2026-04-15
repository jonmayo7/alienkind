-- Migration 054: Trust Score Hash Chain — tamper-evident provenance for trust scores
--
-- Adds cryptographic hash chain columns to trust_scores. Each record includes:
--   evidence_hash  — SHA-256 of the component_details JSON (the raw evidence)
--   previous_hash  — chain_hash from the prior record ("genesis" for the first)
--   chain_hash     — SHA-256 of (previous_hash + evidence_hash + score + computed_at)
--   chain_valid    — set to false if chain validation detects a break
--
-- The chain ensures that if anyone alters a historical score, the chain breaks
-- visibly when validated. Like a mini blockchain for trust.
--
-- Written by: trust-provenance.ts recordTrustScore()
-- Validated by: trust-provenance.ts validateChain()

ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS evidence_hash TEXT;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS previous_hash TEXT;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS chain_hash TEXT;
ALTER TABLE trust_scores ADD COLUMN IF NOT EXISTS chain_valid BOOLEAN DEFAULT TRUE;

-- Index for chain validation queries (walk the chain in order)
CREATE INDEX IF NOT EXISTS idx_ts_chain_hash ON trust_scores(chain_hash);

COMMENT ON COLUMN trust_scores.evidence_hash IS 'SHA-256 of deterministic JSON.stringify(component_details) — fingerprint of the raw evidence';
COMMENT ON COLUMN trust_scores.previous_hash IS 'chain_hash from the preceding trust_scores row, or "genesis" for the first record';
COMMENT ON COLUMN trust_scores.chain_hash IS 'SHA-256 of (previous_hash + evidence_hash + score + computed_at) — the chain link';
COMMENT ON COLUMN trust_scores.chain_valid IS 'Set to false if validateChain() detects this link was tampered with';
