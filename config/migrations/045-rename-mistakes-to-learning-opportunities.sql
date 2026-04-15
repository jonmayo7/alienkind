-- Rename mistakes table to learning_opportunities
ALTER TABLE IF EXISTS mistakes RENAME TO learning_opportunities;

-- Rename indexes
ALTER INDEX IF EXISTS idx_mistakes_pattern RENAME TO idx_learning_opportunities_pattern;
ALTER INDEX IF EXISTS idx_mistakes_occurrence RENAME TO idx_learning_opportunities_occurrence;
ALTER INDEX IF EXISTS idx_mistakes_severity RENAME TO idx_learning_opportunities_severity;
ALTER INDEX IF EXISTS idx_mistakes_category RENAME TO idx_learning_opportunities_category;
ALTER INDEX IF EXISTS idx_mistakes_created RENAME TO idx_learning_opportunities_created;
ALTER INDEX IF EXISTS idx_mistakes_not_promoted RENAME TO idx_learning_opportunities_not_promoted;
ALTER INDEX IF EXISTS idx_mistakes_fts RENAME TO idx_learning_opportunities_fts;

-- Rename function and trigger
ALTER FUNCTION IF EXISTS update_mistakes_updated_at() RENAME TO update_learning_opportunities_updated_at;
DROP TRIGGER IF EXISTS mistakes_updated_at ON learning_opportunities;
CREATE TRIGGER learning_opportunities_updated_at
  BEFORE UPDATE ON learning_opportunities
  FOR EACH ROW EXECUTE FUNCTION update_learning_opportunities_updated_at();

-- Update intent source values
UPDATE intents SET source = 'recurring_learning_opportunities' WHERE source = 'recurring_mistakes';
