-- Prompt cache usage on turns. input_tokens from here on counts uncached input
-- only: the prompt less cache reads and writes.
ALTER TABLE public.turns
    ADD COLUMN cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN cache_write_tokens BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT turns_cache_nonnegative CHECK (cache_read_tokens >= 0 AND cache_write_tokens >= 0);
