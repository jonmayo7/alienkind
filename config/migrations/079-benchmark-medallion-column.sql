-- Add medallion column to benchmark_daily for synthetic Medallion Fund benchmark
ALTER TABLE benchmark_daily ADD COLUMN IF NOT EXISTS medallion NUMERIC;
