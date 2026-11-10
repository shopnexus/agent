-- ============================================================
-- ShopNexus Agent — Full Database Schema
-- PostgreSQL 14+; pgvector 0.5+; single public schema; no tenancy.
-- ============================================================
-- Bootstrap script for a NEW database, NOT an upgrade migration.
-- actors -> conversations -> turns -> messages -> message_blocks.
-- tool_calls stores execution audit; retrieval stores memory and document excerpts.
-- This script does not copy or drop existing sessions/memories tables.
-- CREATE TABLE IF NOT EXISTS does not upgrade existing table definitions.
-- Requires permission to install extensions and pgvector on the database host.
-- Stored embeddings and query embeddings must use the same 1024-dimensional
-- embedding model and vector space.
-- ============================================================

SET search_path TO public;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- PostgreSQL has no CREATE TYPE IF NOT EXISTS syntax.
-- These blocks skip existing types; they do not modify their enum labels.
DO $$
BEGIN
    CREATE TYPE public.conversation_status AS ENUM ('active', 'archived', 'closed');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    CREATE TYPE public.turn_status AS ENUM (
        'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL',
        'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    CREATE TYPE public.message_role AS ENUM ('USER', 'ASSISTANT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    CREATE TYPE public.message_block_kind AS ENUM (
        'THINKING', 'TEXT', 'TOOL_USE', 'TOOL_RESULT',
        'CLARIFICATION_REQUEST', 'APPROVAL_REQUEST'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    CREATE TYPE public.tool_call_status AS ENUM (
        'pending', 'running', 'success', 'failed', 'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    CREATE TYPE public.retrieval_origin AS ENUM ('STATEMENT', 'EXCERPT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    CREATE TYPE public.retrieval_kind AS ENUM ('FACT', 'PREFERENCE', 'SUMMARY');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

-- ----------------------------------------------------------
-- 1. actors — stable customer identities across conversations
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.actors (
    id          VARCHAR(64) PRIMARY KEY,
    locale      VARCHAR(8)  NOT NULL DEFAULT 'en-US',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------
-- 2. conversations — replaces the former sessions table
-- ----------------------------------------------------------
-- One conversation belongs to one actor. An actor may have many conversations.
-- Conversation history is reconstructed from turns, messages, and blocks.
-- active: open for normal use; archived: hidden from the active list;
-- closed: finished. The application enforces write/transition rules.
CREATE TABLE IF NOT EXISTS public.conversations (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id         VARCHAR(64)  NOT NULL
                     REFERENCES public.actors(id) ON DELETE CASCADE,
    title            TEXT,
    status           public.conversation_status NOT NULL DEFAULT 'active',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_actor
    ON public.conversations(actor_id, last_activity_at DESC, id);

-- ----------------------------------------------------------
-- 3. turns — one agent run, potentially many model/tool calls
-- ----------------------------------------------------------
-- The owning actor is resolved through conversations; it is not duplicated here.
-- User input and assistant output live in message_blocks, not input_text/output_text.
-- Counters are run totals, updated by the application across all model calls.
CREATE TABLE IF NOT EXISTS public.turns (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID          NOT NULL
                    REFERENCES public.conversations(id) ON DELETE CASCADE,
    ordinal         INT           NOT NULL,
    status          public.turn_status NOT NULL DEFAULT 'RUNNING',
    model_id        VARCHAR(128),
    stop_reason     VARCHAR(32),
    input_tokens    BIGINT        NOT NULL DEFAULT 0,
    output_tokens   BIGINT        NOT NULL DEFAULT 0,
    latency_ms      BIGINT,
    started_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    error_code      VARCHAR(128),
    error_message   TEXT,

    CONSTRAINT turns_ordinal_nonnegative CHECK (ordinal >= 0),
    CONSTRAINT turns_usage_nonnegative CHECK (
        input_tokens >= 0 AND output_tokens >= 0
    ),
    CONSTRAINT turns_latency_nonnegative
        CHECK (latency_ms IS NULL OR latency_ms >= 0),
    CONSTRAINT turns_finished_state CHECK (
        (status IN ('RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL')
            AND finished_at IS NULL)
        OR
        (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
            AND finished_at IS NOT NULL)
    ),
    CONSTRAINT turns_time_order
        CHECK (finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT turns_conversation_ordinal_unique
        UNIQUE (conversation_id, ordinal),
    -- Supports the composite FK that keeps messages in their turn's conversation.
    CONSTRAINT turns_id_conversation_unique UNIQUE (id, conversation_id)
);

-- The unique ordinal index also supports recent-history lookup by conversation.
-- Only one unfinished run may own a conversation at a time, including paused runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_unfinished
    ON public.turns(conversation_id)
    WHERE status IN ('RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL');

-- ----------------------------------------------------------
-- 4. messages — USER or ASSISTANT envelopes within a turn
-- ----------------------------------------------------------
-- Content lives in ordered message_blocks, not a JSON content column.
-- Tool calls/results belong to ASSISTANT blocks, not standalone TOOL messages.
-- Additional USER messages may arrive while the same turn is running.
CREATE TABLE IF NOT EXISTS public.messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id         UUID        NOT NULL,
    conversation_id UUID        NOT NULL,
    role            public.message_role NOT NULL,
    ordinal         INT         NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT messages_turn_conversation_fk
        FOREIGN KEY (turn_id, conversation_id)
        REFERENCES public.turns(id, conversation_id) ON DELETE CASCADE,
    CONSTRAINT messages_ordinal_nonnegative CHECK (ordinal >= 0),
    CONSTRAINT messages_turn_ordinal_unique UNIQUE (turn_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON public.messages(conversation_id, created_at, id);

-- ----------------------------------------------------------
-- 5. message_blocks — ordered, typed transcript content
-- ----------------------------------------------------------
-- TEXT: user text, assistant progress, or a terminal answer.
-- THINKING: safe reasoning summaries only, never raw chain-of-thought.
-- TOOL_USE: tool arguments in payload; tool_use_id pairs the result with its call.
-- TOOL_RESULT: structured output/error/reference in payload.
-- CLARIFICATION_REQUEST / APPROVAL_REQUEST: structured questions or approvals.
-- Persist each completed block immediately instead of waiting for turn completion.
-- event_seq is a positive sequence within a message; reuse it on event retries.
CREATE TABLE IF NOT EXISTS public.message_blocks (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID         NOT NULL
                REFERENCES public.messages(id) ON DELETE CASCADE,
    ordinal     INT          NOT NULL,
    kind        public.message_block_kind NOT NULL,
    is_terminal BOOLEAN      NOT NULL DEFAULT FALSE,
    text        TEXT,
    tool_use_id VARCHAR(64),
    tool_name   VARCHAR(128),
    payload     JSONB,
    event_seq   BIGINT       NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT message_blocks_ordinal_nonnegative CHECK (ordinal >= 0),
    CONSTRAINT message_blocks_event_positive CHECK (event_seq > 0),
    CONSTRAINT message_blocks_terminal_text_only
        CHECK (NOT is_terminal OR kind = 'TEXT'),
    CONSTRAINT message_blocks_text_required
        CHECK (kind NOT IN ('TEXT', 'THINKING') OR text IS NOT NULL),
    CONSTRAINT message_blocks_payload_required CHECK (
        kind NOT IN (
            'TOOL_USE', 'TOOL_RESULT', 'CLARIFICATION_REQUEST', 'APPROVAL_REQUEST'
        ) OR (payload IS NOT NULL AND payload <> 'null'::jsonb)
    ),
    CONSTRAINT message_blocks_tool_id_required CHECK (
        kind NOT IN ('TOOL_USE', 'TOOL_RESULT')
        OR (tool_use_id IS NOT NULL AND btrim(tool_use_id) <> '')
    ),
    CONSTRAINT message_blocks_tool_name_required CHECK (
        kind <> 'TOOL_USE'
        OR (tool_name IS NOT NULL AND btrim(tool_name) <> '')
    ),
    CONSTRAINT message_blocks_message_ordinal_unique UNIQUE (message_id, ordinal),
    CONSTRAINT message_blocks_event_unique UNIQUE (message_id, event_seq)
);

-- The unique ordinal index also supports ordered block retrieval by message.
CREATE INDEX IF NOT EXISTS idx_message_blocks_tool_use
    ON public.message_blocks(tool_use_id)
    WHERE tool_use_id IS NOT NULL;

-- ----------------------------------------------------------
-- 6. tool_calls — execution audit, separate from transcript rendering
-- ----------------------------------------------------------
-- message_blocks is the source for conversation replay.
-- This table stores execution status, latency, and operational output metadata.
-- The application must keep audit and transcript events consistent, preferably
-- in one transaction, using (turn_id, tool_use_id) as the logical call identity.
CREATE TABLE IF NOT EXISTS public.tool_calls (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    turn_id         UUID         NOT NULL
                    REFERENCES public.turns(id) ON DELETE CASCADE,
    tool_use_id     VARCHAR(64)  NOT NULL,
    tool_name       VARCHAR(128) NOT NULL,
    tool_source     VARCHAR(32),
    input           JSONB        NOT NULL DEFAULT '{}',
    output          TEXT,
    output_spilled  BOOLEAN      NOT NULL DEFAULT FALSE,
    status          public.tool_call_status NOT NULL DEFAULT 'success',
    latency_ms      INT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT tool_calls_turn_use_unique UNIQUE (turn_id, tool_use_id),
    CONSTRAINT tool_calls_latency_nonnegative
        CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

-- The unique call identity index also supports lookup by turn_id.
CREATE INDEX IF NOT EXISTS idx_tool_calls_name
    ON public.tool_calls(tool_name, created_at DESC);

-- ----------------------------------------------------------
-- 7. retrieval — actor-owned memory and document excerpts
-- ----------------------------------------------------------
-- No tenant, collection, sharing, or agent scope. Every row belongs to one actor.
-- STATEMENT: a remembered fact, preference, or summary; kind is required.
-- EXCERPT: a document chunk; kind is NULL and document_id/chunk_index are required.
-- document_id is a stable UUID assigned by the importing application, NOT a FK:
-- this schema does not include a document registry or binary file storage.
-- document_title and source_uri are optional citation metadata repeated per chunk.
-- locator identifies a page, section, or other source position.
-- source_turn_id is provenance only; it does not restrict recall to a conversation.
CREATE TABLE IF NOT EXISTS public.retrieval (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        VARCHAR(64) NOT NULL
                    REFERENCES public.actors(id) ON DELETE CASCADE,
    origin          public.retrieval_origin NOT NULL,
    kind            public.retrieval_kind,
    importance      SMALLINT    NOT NULL DEFAULT 3,
    content         TEXT        NOT NULL,
    search_text     TEXT        NOT NULL,
    embedding       vector(1024) NOT NULL,
    source_turn_id  UUID
                    REFERENCES public.turns(id) ON DELETE SET NULL,
    document_id     UUID,
    document_title  TEXT,
    source_uri      TEXT,
    chunk_index     INT,
    locator         TEXT,
    superseded_at   TIMESTAMPTZ,
    superseded_by   UUID
                    REFERENCES public.retrieval(id) ON DELETE SET NULL,
    deleted_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT retrieval_importance_range CHECK (importance BETWEEN 1 AND 5),
    CONSTRAINT retrieval_actor_not_blank CHECK (btrim(actor_id) <> ''),
    CONSTRAINT retrieval_content_not_blank CHECK (btrim(content) <> ''),
    CONSTRAINT retrieval_search_text_not_blank CHECK (btrim(search_text) <> ''),
    CONSTRAINT retrieval_origin_fields CHECK (
        (origin = 'STATEMENT' AND kind IS NOT NULL
            AND document_id IS NULL AND document_title IS NULL
            AND source_uri IS NULL AND chunk_index IS NULL AND locator IS NULL)
        OR
        (origin = 'EXCERPT' AND kind IS NULL
            AND document_id IS NOT NULL AND chunk_index IS NOT NULL)
    ),
    CONSTRAINT retrieval_chunk_index_nonnegative
        CHECK (chunk_index IS NULL OR chunk_index >= 0),
    CONSTRAINT retrieval_no_self_replacement
        CHECK (superseded_by IS NULL OR superseded_by <> id),
    CONSTRAINT retrieval_replacement_requires_retirement
        CHECK (superseded_by IS NULL OR superseded_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_actor
    ON public.retrieval(actor_id);

-- Expiry is checked at query time: NOW() is not immutable and cannot appear
-- in a partial-index predicate. Expired records may remain indexed until purged.
CREATE INDEX IF NOT EXISTS idx_retrieval_active
    ON public.retrieval(actor_id, origin, kind, updated_at DESC)
    WHERE superseded_at IS NULL AND deleted_at IS NULL;

-- Supports ordered document reads, reindexing, and actor-scoped document purge.
CREATE INDEX IF NOT EXISTS idx_retrieval_document
    ON public.retrieval(actor_id, document_id, chunk_index)
    WHERE document_id IS NOT NULL;

-- HNSW does not need a training dataset. Reject zero vectors in the application:
-- cosine indexes do not index them, even though vector(1024) accepts them.
CREATE INDEX IF NOT EXISTS idx_retrieval_embedding
    ON public.retrieval USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128)
    WHERE superseded_at IS NULL AND deleted_at IS NULL;

-- Built-in configuration: no dependency on the portal's memory_simple config.
CREATE INDEX IF NOT EXISTS idx_retrieval_fts
    ON public.retrieval USING gin (to_tsvector('simple', search_text))
    WHERE superseded_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_retrieval_trgm
    ON public.retrieval USING gin (search_text gin_trgm_ops)
    WHERE superseded_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_retrieval_source_turn
    ON public.retrieval(source_turn_id)
    WHERE source_turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_retrieval_superseded_by
    ON public.retrieval(superseded_by)
    WHERE superseded_by IS NOT NULL;

-- ----------------------------------------------------------
-- 8. updated_at maintenance
-- ----------------------------------------------------------
-- Activity timestamps and usage counters are maintained by the application.
-- Updating a turn/block does not automatically update its conversation row.
CREATE OR REPLACE FUNCTION public.shopnexus_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_actors_updated_at
    BEFORE UPDATE ON public.actors
    FOR EACH ROW EXECUTE FUNCTION public.shopnexus_set_updated_at();

CREATE OR REPLACE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON public.conversations
    FOR EACH ROW EXECUTE FUNCTION public.shopnexus_set_updated_at();

CREATE OR REPLACE TRIGGER trg_retrieval_updated_at
    BEFORE UPDATE ON public.retrieval
    FOR EACH ROW EXECUTE FUNCTION public.shopnexus_set_updated_at();