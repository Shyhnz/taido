-- The question Claude ended its turn with, detected on the
-- full `Stop.last_assistant_message`. `last_message` keeps only the first 500 characters,
-- so a question at the end of a long message cannot be found again from it.

ALTER TABLE agent_sessions ADD COLUMN question TEXT;  -- set in Waiting(Question) only
