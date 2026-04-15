-- ============================================================
-- MIGRATION 069: Upgrade embedding column from 768 to 4096 dims
-- Switches from nomic-embed-text (768d) to Qwen3-Embedding 8B (4096d).
-- Qwen3-Embedding 8B: MTEB 70.58, #1 open-source on Ollama for Apple Silicon.
-- NOTE: HNSW index creation FAILED on Supabase pgvector 0.8.0 —
--   "column cannot have more than 2000 dimensions for hnsw index"
--   Supabase's build enforces 2000-dim cap despite pgvector 0.8.0 changelog.
--   Step 4 is a no-op; brute-force scan on 52K rows is <100ms.
--   Re-attempt index after Supabase upgrades pgvector.
-- Date: 2026-03-30
-- ============================================================

-- Step 1: Drop existing HNSW index (dimension change requires rebuild)
DROP INDEX IF EXISTS idx_memory_chunks_embedding;

-- Step 2: NULL all existing 768-dim embeddings (incompatible with 4096-dim)
UPDATE memory_chunks SET embedding = NULL;

-- Step 3: Alter column to 4096 dimensions
ALTER TABLE memory_chunks ALTER COLUMN embedding TYPE vector(4096);

-- Step 4: HNSW index for 4096 dims — SKIPPED
-- Supabase pgvector enforces 2000-dim cap for HNSW. Brute-force scan is <100ms on typical datasets.
-- Re-attempt after Supabase upgrades pgvector:
-- CREATE INDEX idx_memory_chunks_embedding ON memory_chunks USING hnsw (embedding vector_cosine_ops);

-- Step 5: Replace RPC function with 4096-dim parameter
CREATE OR REPLACE FUNCTION hybrid_memory_search(
  query_embedding vector(4096),
  query_text text,
  match_count int DEFAULT 10,
  file_type_filter text DEFAULT NULL,
  since_date date DEFAULT NULL
)
RETURNS TABLE (
  id bigint,
  source_file text,
  heading text,
  content text,
  file_type text,
  file_date date,
  vector_score float,
  fts_score float,
  hybrid_score float
)
LANGUAGE sql STABLE
AS $$
  WITH vector_results AS (
    SELECT
      mc.id,
      mc.source_file,
      mc.heading,
      mc.content,
      mc.file_type,
      mc.file_date,
      1 - (mc.embedding <=> query_embedding) AS vector_score
    FROM memory_chunks mc
    WHERE mc.embedding IS NOT NULL
      AND (file_type_filter IS NULL OR mc.file_type = file_type_filter)
      AND (since_date IS NULL OR mc.file_date >= since_date)
    ORDER BY mc.embedding <=> query_embedding
    LIMIT match_count * 3
  ),
  fts_results AS (
    SELECT
      mc.id,
      ts_rank_cd(mc.content_tsv, websearch_to_tsquery('english', query_text)) AS fts_score
    FROM memory_chunks mc
    WHERE mc.content_tsv @@ websearch_to_tsquery('english', query_text)
      AND (file_type_filter IS NULL OR mc.file_type = file_type_filter)
      AND (since_date IS NULL OR mc.file_date >= since_date)
    LIMIT match_count * 3
  )
  SELECT
    v.id,
    v.source_file,
    v.heading,
    v.content,
    v.file_type,
    v.file_date,
    v.vector_score,
    COALESCE(f.fts_score, 0) AS fts_score,
    (0.7 * v.vector_score + 0.3 * COALESCE(f.fts_score, 0)) AS hybrid_score
  FROM vector_results v
  LEFT JOIN fts_results f ON v.id = f.id
  ORDER BY (0.7 * v.vector_score + 0.3 * COALESCE(f.fts_score, 0)) DESC
  LIMIT match_count;
$$;
