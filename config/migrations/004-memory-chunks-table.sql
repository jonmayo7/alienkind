-- ============================================================
-- MIGRATION 004: Memory Chunks Table (Full-Text Search)
-- Stores chunked memory files for semantic search.
-- Uses Postgres tsvector for full-text search, upgradeable to pgvector.
-- Date: 2026-02-19
-- ============================================================

-- Memory file chunks — indexed for full-text search.
-- Chunked by section (## headers). Each chunk has a heading and content.
CREATE TABLE IF NOT EXISTS memory_chunks (
  id bigserial PRIMARY KEY,
  source_file text NOT NULL,
  chunk_index int NOT NULL,
  heading text,
  content text NOT NULL,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED,
  file_type text NOT NULL,
  file_date date,
  checksum text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(source_file, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_tsv ON memory_chunks USING gin(content_tsv);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source_file);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_type ON memory_chunks(file_type);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_date ON memory_chunks(file_date DESC);

-- RLS
ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON memory_chunks FOR ALL USING (true);

-- Grant readonly access
GRANT SELECT ON memory_chunks TO partner_readonly;
