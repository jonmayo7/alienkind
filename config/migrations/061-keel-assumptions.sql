-- Migration 061: keel_assumptions table
-- Fallibilism Phase 3: Structured assumption tracking.
-- Every belief the organism holds can be challenged, verified, or retired.

CREATE TABLE IF NOT EXISTS keel_assumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assumption TEXT NOT NULL,
  evidence TEXT,
  domain TEXT,  -- architecture, strategy, behavioral, product
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'challenged', 'retired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_verified TIMESTAMPTZ,
  challenged_at TIMESTAMPTZ,
  challenge_evidence TEXT,
  retired_at TIMESTAMPTZ
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_keel_assumptions_status ON keel_assumptions(status);
CREATE INDEX IF NOT EXISTS idx_keel_assumptions_domain ON keel_assumptions(domain);

-- RLS: service role only (matches pattern from other keel_ tables)
ALTER TABLE keel_assumptions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DROP POLICY IF EXISTS "service_role_all" ON keel_assumptions;
CREATE POLICY "service_role_all" ON keel_assumptions
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
