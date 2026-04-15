-- Add medallion column to benchmark_daily for synthetic Medallion Fund benchmark
-- benchmark_daily not created in included migrations — guard with IF EXISTS
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'benchmark_daily') THEN
    ALTER TABLE benchmark_daily ADD COLUMN IF NOT EXISTS medallion NUMERIC;
  END IF;
END $$;
