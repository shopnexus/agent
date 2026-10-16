-- Initialize pgvector and memory schema for ShopNexus E-commerce Agent
CREATE SCHEMA IF NOT EXISTS retrieval;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS retrieval.user_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(64) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'buyer',
    category VARCHAR(32) NOT NULL,
    importance SMALLINT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    content TEXT NOT NULL,
    search_text TEXT NOT NULL,
    embedding vector(768) NOT NULL,
    superseded_at TIMESTAMPTZ NULL,
    superseded_by UUID NULL REFERENCES retrieval.user_memories(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_memories_lookup ON retrieval.user_memories(user_id, role, category, superseded_at);
CREATE INDEX IF NOT EXISTS idx_user_memories_embedding ON retrieval.user_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_user_memories_fts ON retrieval.user_memories USING GIN (to_tsvector('simple', search_text));
