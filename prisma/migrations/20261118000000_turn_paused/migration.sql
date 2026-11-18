-- A paused run: not terminal, continued by Continue or a message.
-- A separate migration because a new enum value cannot be used in the
-- transaction that adds it, and 20261118000001_runs uses it.
ALTER TYPE public.turn_status ADD VALUE IF NOT EXISTS 'PAUSED' AFTER 'RUNNING';
