-- Publish Holds: privacy-gate as a discernment engine.
--
-- Origin: built after an audit found that scripts/lib/privacy-gate.ts
-- (a regex scanner for sensitive content) had ZERO callers in the publish path. The original wiring was deleted because the regex
-- was too noisy and brittle to ship as a hard block. Re-wiring as-is would
-- recreate the original failure mode.
--
-- The fix: scan → hold → surface → resolve. This table is the "hold" layer.
-- When privacyGate() matches in any external publish path, the publish is
-- halted and a row lands here. Telegram + dashboard surface it. the human resolves
-- with approve / deny / mark-false-positive. Default to BLOCK after 24h with
-- no response — fail closed, the whole point is to never silently publish.
--
-- Resolution outcomes feed AIRE: approvals tighten patterns (overbroad),
-- denials confirm patterns (correct), false-positive marks add per-pattern
-- exceptions. Over time the regex calibrates from real labeled data instead
-- of staying brittle.

CREATE TABLE IF NOT EXISTS publish_holds (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- What was held
  channel         text NOT NULL,           -- 'x', 'linkedin', 'email', 'gmail', etc.
  target          text,                    -- '[@PARTNER_HANDLE]', 'the human-linkedin', recipient email, etc.
  content         text NOT NULL,           -- the full text that was about to publish
  content_hash    text NOT NULL,           -- sha256 prefix for dedup + reference

  -- Why it was held
  matched_patterns jsonb NOT NULL,         -- array of {category, pattern, matched, detail}
  match_count     int NOT NULL DEFAULT 0,  -- denormalized for fast filtering
  highest_category text,                   -- 'family-health', 'family-finance', 'family-minor', 'family-private'

  -- Where it came from
  source_script   text,                    -- 'post-to-x.ts', 'post-to-linkedin.ts', etc.
  source_caller   text,                    -- script or human who initiated the publish

  -- Resolution
  status          text NOT NULL DEFAULT 'pending',
    -- pending: held, awaiting the human
    -- approved: the human approved, publish should fire
    -- denied: the human denied, publish killed permanently
    -- false_positive: the human marked as overbroad, publish fires + pattern exception added
    -- expired: 24h elapsed without response, defaulted to BLOCK (fail closed)
  resolved_by     text,                    -- 'the human', 'auto-expire', etc.
  resolution_notes text,                   -- the human's reason if provided

  -- Timestamps
  created_at      timestamptz DEFAULT now(),
  resolved_at     timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),

  -- AIRE learning
  learning_logged boolean DEFAULT false    -- has this resolution been fed back into pattern weights?
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_publish_holds_status ON publish_holds(status);
CREATE INDEX IF NOT EXISTS idx_publish_holds_pending ON publish_holds(created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_publish_holds_expires ON publish_holds(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_publish_holds_channel ON publish_holds(channel);
CREATE INDEX IF NOT EXISTS idx_publish_holds_content_hash ON publish_holds(content_hash);

-- RLS: service role only (matches mission_packets pattern, no public access)
ALTER TABLE publish_holds ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "service_role_all" ON publish_holds
    FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE publish_holds IS 'Privacy-gate discernment engine: holds external publishes when privacyGate() matches. Surfaces to the human via your notification channel + dashboard. Resolves to approved/denied/false-positive/expired. Default to BLOCK on 24h no-response — fail closed, never silently publish.';
