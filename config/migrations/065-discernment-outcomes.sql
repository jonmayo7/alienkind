-- Discernment engine outcome tracking
-- Stores every evaluate decision + eventual outcome for AIRE tuning
-- Architecture mirrors signal_attribution (trading) — same feedback loop pattern

CREATE TABLE IF NOT EXISTS discernment_outcomes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel TEXT NOT NULL,                          -- 'war_room', 'discord_partner', etc.
  action TEXT NOT NULL,                           -- 'silence', 'react', 'respond', 'build', 'start', 'coordinate'
  composite_score REAL,                           -- 0-1 weighted signal score
  regime TEXT,                                    -- 'stopped', 'hot', 'warm', 'cold', 'directed', 'ambient'
  silicon_ratio REAL,                             -- 0-1 proportion of silicon messages
  velocity REAL,                                  -- messages per minute at decision time
  signals JSONB,                                  -- full signal array for post-hoc analysis
  outcome TEXT,                                   -- 'engaged', 'extended', 'corrected', 'ignored', 'stopped'
  outcome_at TIMESTAMPTZ,                         -- when outcome was observed
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for AIRE tuning queries (recent outcomes with labels)
CREATE INDEX IF NOT EXISTS idx_discernment_outcomes_tuning
  ON discernment_outcomes (created_at DESC)
  WHERE outcome IS NOT NULL;

-- Index for per-channel analysis
CREATE INDEX IF NOT EXISTS idx_discernment_outcomes_channel
  ON discernment_outcomes (channel, created_at DESC);
