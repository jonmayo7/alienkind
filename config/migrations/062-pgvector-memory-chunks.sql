-- ============================================================
-- MIGRATION 062: Add pgvector embedding column to memory_chunks
-- Enables hybrid search: 70% vector similarity + 30% FTS.
-- nomic-embed-text generates 768-dim embeddings locally via Ollama.
-- (Qwen3-Embedding 8B outputs 4096 dims — exceeds pgvector HNSW 2000-dim limit)
-- Date: 2026-03-26
-- ============================================================

-- Enable pgvector extension (Supabase Pro includes it)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column (768 dimensions — nomic-embed-text / Qwen3-Embedding)
ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS embedding vector(768);

-- HNSW index for cosine similarity (ivfflat caps at 2000 dims, HNSW supports 4096)
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding
  ON memory_chunks USING hnsw (embedding vector_cosine_ops);

-- RPC function for hybrid search (70% vector + 30% FTS)
CREATE OR REPLACE FUNCTION hybrid_memory_search(
  query_embedding vector(768),
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
