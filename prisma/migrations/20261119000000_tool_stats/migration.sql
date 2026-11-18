-- Settings figures: failed attempts and labels on tool calls, and indexes for
-- reading tool calls, guardrail events and turns by time.

ALTER TABLE public.tool_calls
    ADD COLUMN attempt_errors JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN tool_label     VARCHAR(200);

CREATE INDEX idx_tool_calls_created ON public.tool_calls(created_at);
CREATE INDEX idx_turn_events_type_at ON public.turn_events(type, at);
CREATE INDEX idx_turns_started ON public.turns(started_at);
