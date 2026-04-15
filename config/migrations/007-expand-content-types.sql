-- Migration 007: Expand content_performance content_type check constraint
-- Session 37: Content tracking system needs granular types for X/LinkedIn
-- Old: newsletter, blog, social_x, social_linkedin, email_campaign
-- New: adds x_post, x_thread, x_thread_reply, linkedin_post for specific tracking

-- content_performance was created in an excluded migration; guard with IF EXISTS
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'content_performance') THEN
    ALTER TABLE content_performance
      DROP CONSTRAINT content_performance_content_type_check;

    ALTER TABLE content_performance
      ADD CONSTRAINT content_performance_content_type_check
      CHECK (content_type IN (
        'newsletter', 'blog', 'email_campaign',
        'social_x', 'social_linkedin',
        'x_post', 'x_thread', 'x_thread_reply',
        'linkedin_post'
      ));
  END IF;
END $$;
