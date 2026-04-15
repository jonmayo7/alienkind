-- Add secondary_domains column to circulation table.
-- Enables cross-domain discovery: findings tagged with secondary domains
-- appear when organs withdraw by any of those domains.
-- Column is JSONB storing a string array, e.g. ["security", "trading"].

ALTER TABLE circulation
ADD COLUMN IF NOT EXISTS secondary_domains jsonb DEFAULT '[]'::jsonb;

-- GIN index for efficient containment queries (@> operator)
CREATE INDEX IF NOT EXISTS idx_circulation_secondary_domains
ON circulation USING gin (secondary_domains);
