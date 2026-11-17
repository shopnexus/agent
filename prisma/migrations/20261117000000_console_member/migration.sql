-- Console members: conversation subjects and who asked each turn.
-- Applies on top of 20261111000000_new_database; together they equal
-- docker/init-db/01-init-schema.sql.

DO $$
BEGIN
    CREATE TYPE public.conversation_subject_kind AS ENUM ('ticket', 'report_case', 'account');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

ALTER TABLE public.conversations
    ADD COLUMN subject_kind public.conversation_subject_kind,
    ADD COLUMN subject_id   UUID,
    ADD CONSTRAINT conversations_subject_pair
        CHECK ((subject_kind IS NULL) = (subject_id IS NULL));

CREATE UNIQUE INDEX idx_conversations_subject
    ON public.conversations(subject_kind, subject_id)
    WHERE subject_kind IS NOT NULL;

-- Existing turns were asked by the conversation's owner.
ALTER TABLE public.turns ADD COLUMN member_id VARCHAR(64);
UPDATE public.turns t SET member_id = c.actor_id
    FROM public.conversations c WHERE c.id = t.conversation_id;
ALTER TABLE public.turns
    ALTER COLUMN member_id SET NOT NULL,
    ADD CONSTRAINT turns_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES public.actors(id);

CREATE INDEX idx_turns_running
    ON public.turns(started_at)
    WHERE status = 'RUNNING';
