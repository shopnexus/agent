-- Runs: the turn's event log, durable run state, usage, documents and skills.
-- Applies on top of 20261118000000_turn_paused; together with the earlier
-- migrations they equal docker/init-db/01-init-schema.sql.

ALTER TABLE public.turns
    ADD COLUMN agent_id       VARCHAR(64),
    ADD COLUMN agent_name     TEXT,
    ADD COLUMN cost_usd       NUMERIC(12, 6) NOT NULL DEFAULT 0,
    ADD COLUMN first_token_ms INT,
    ADD COLUMN provider       VARCHAR(128),
    ADD COLUMN run_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN deadline_ms    INT NOT NULL DEFAULT 60000,
    ADD COLUMN event_seq      BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN state          JSONB;

UPDATE public.turns SET run_started_at = started_at;

ALTER TABLE public.turns DROP CONSTRAINT turns_finished_state;
ALTER TABLE public.turns ADD CONSTRAINT turns_finished_state CHECK (
    (status IN ('RUNNING', 'PAUSED', 'AWAITING_INPUT', 'AWAITING_APPROVAL')
        AND finished_at IS NULL)
    OR
    (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT')
        AND finished_at IS NOT NULL)
);
ALTER TABLE public.turns ADD CONSTRAINT turns_cost_nonnegative CHECK (cost_usd >= 0);

DROP INDEX IF EXISTS public.idx_turns_one_unfinished;
CREATE UNIQUE INDEX idx_turns_one_unfinished
    ON public.turns(conversation_id)
    WHERE status IN ('RUNNING', 'PAUSED', 'AWAITING_INPUT', 'AWAITING_APPROVAL');

DROP INDEX IF EXISTS public.idx_turns_running;
CREATE INDEX idx_turns_running
    ON public.turns(run_started_at)
    WHERE status = 'RUNNING';

-- One row per event a reader replays; seq comes from turns.event_seq.
CREATE TABLE public.turn_events (
    turn_id UUID        NOT NULL REFERENCES public.turns(id) ON DELETE CASCADE,
    seq     BIGINT      NOT NULL,
    type    VARCHAR(48) NOT NULL,
    body    JSONB       NOT NULL DEFAULT '{}',
    at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (turn_id, seq),
    CONSTRAINT turn_events_seq_positive CHECK (seq > 0)
);

ALTER TABLE public.tool_calls
    ADD COLUMN attempts    INT NOT NULL DEFAULT 1,
    ADD COLUMN timing      JSONB,
    ADD COLUMN finished_at TIMESTAMPTZ,
    ADD CONSTRAINT tool_calls_attempts_positive CHECK (attempts >= 1);

-- Documents live with their chat and go with it.
CREATE TABLE public.documents (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    turn_id         UUID        REFERENCES public.turns(id) ON DELETE SET NULL,
    title           TEXT        NOT NULL,
    latest_version  INT         NOT NULL DEFAULT 1,
    created_by      VARCHAR(64) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT documents_version_positive CHECK (latest_version >= 1)
);
CREATE INDEX idx_documents_conversation ON public.documents(conversation_id, updated_at DESC);

CREATE TABLE public.document_versions (
    document_id UUID        NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    version     INT         NOT NULL,
    title       TEXT        NOT NULL,
    sections    JSONB       NOT NULL,
    turn_id     UUID,
    created_by  VARCHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (document_id, version),
    CONSTRAINT document_versions_version_positive CHECK (version >= 1)
);

-- Skills are shared with every member.
CREATE TABLE public.skills (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by  VARCHAR(64) NOT NULL,
    name        TEXT        NOT NULL,
    slug        VARCHAR(64) NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    prompt      TEXT        NOT NULL,
    variables   JSONB       NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT skills_slug_unique UNIQUE (slug)
);

CREATE OR REPLACE TRIGGER trg_documents_updated_at
    BEFORE UPDATE ON public.documents
    FOR EACH ROW EXECUTE FUNCTION public.shopnexus_set_updated_at();

CREATE OR REPLACE TRIGGER trg_skills_updated_at
    BEFORE UPDATE ON public.skills
    FOR EACH ROW EXECUTE FUNCTION public.shopnexus_set_updated_at();
