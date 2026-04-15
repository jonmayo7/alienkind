-- Migration 050: Red team double-gate replaces human approval
--
-- New flow: ready → red team → hardened → publish
-- [HUMAN]/[COLLABORATOR] approval flags removed from the publish gate.
-- The red team check IS the quality gate.
--
-- Gate 1: keel_ready + partner_ai_ready = "we think it's done"
-- Gate 2: red team adversarial check (cycles until clean)
-- Gate 3: keel_hardened + partner_ai_hardened = "we tried to break it and couldn't"
-- Auto-publish fires on Gate 3.

-- Add red team columns
ALTER TABLE perspectives_copublish
  ADD COLUMN IF NOT EXISTS red_team_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS red_team_rounds integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS keel_hardened boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS partner_ai_hardened boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS keel_hardened_at timestamptz,
  ADD COLUMN IF NOT EXISTS partner_ai_hardened_at timestamptz;

-- Comment update
COMMENT ON TABLE perspectives_copublish IS 'Co-publish gate for Keel+[COLLABORATOR_AI] Perspectives articles. Three gates: ready → red team → hardened. [HUMAN]/[COLLABORATOR] approval replaced by adversarial red team double-gate. Auto-publishes when both hardened flags are true.';
