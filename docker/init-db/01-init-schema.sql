-- ============================================================
-- ShopNexus Agent — Full DB Schema (single public schema)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------
-- 1. actors
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS actors (
    id          VARCHAR(64)  PRIMARY KEY,
    locale      VARCHAR(8)   NOT NULL DEFAULT 'vi',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------
-- 2. sessions
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    VARCHAR(64)  NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    context     JSONB        NOT NULL DEFAULT '{}',
    status      VARCHAR(16)  NOT NULL DEFAULT 'active',
    turn_count  INT          NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_active TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_actor ON sessions(actor_id, last_active DESC);

-- ----------------------------------------------------------
-- 3. turns
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS turns (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID         NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    actor_id      VARCHAR(64)  NOT NULL,
    turn_index    INT          NOT NULL,
    input_text    TEXT,
    output_text   TEXT,
    stop_reason   VARCHAR(32),
    model_id      VARCHAR(64),
    input_tokens  INT,
    output_tokens INT,
    latency_ms    INT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_index);

-- ----------------------------------------------------------
-- 4. messages  (individual conversation history items)
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id     UUID         NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    session_id  UUID         NOT NULL,
    role        VARCHAR(16)  NOT NULL,
    content     JSONB        NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- ----------------------------------------------------------
-- 5. tool_calls
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS tool_calls (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id         UUID         NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    tool_use_id     VARCHAR(64)  NOT NULL,
    tool_name       VARCHAR(128) NOT NULL,
    tool_source     VARCHAR(32),
    input           JSONB        NOT NULL DEFAULT '{}',
    output          TEXT,
    output_spilled  BOOLEAN      NOT NULL DEFAULT FALSE,
    status          VARCHAR(16)  NOT NULL DEFAULT 'success',
    latency_ms      INT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name, created_at DESC);

-- ----------------------------------------------------------
-- 6. user_memories  (long-term personalization — vector + FTS)
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_memories (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        VARCHAR(64)  NOT NULL,
    category        VARCHAR(32)  NOT NULL,
    importance      SMALLINT     NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    content         TEXT         NOT NULL,
    search_text     TEXT         NOT NULL,
    embedding       vector(768)  NOT NULL,
    source_turn_id  UUID         REFERENCES turns(id) ON DELETE SET NULL,
    superseded_at   TIMESTAMPTZ,
    superseded_by   UUID         REFERENCES user_memories(id),
    deleted_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    fact_key        VARCHAR(64),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_memories_lookup
    ON user_memories(actor_id, category, superseded_at, deleted_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_memories_embedding
    ON user_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_user_memories_fts
    ON user_memories USING GIN (to_tsvector('simple', search_text));