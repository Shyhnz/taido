-- How full each conversation's context is, read from the agent's transcript after each reply
-- (`agents::usage`): a `ContextUsage` as JSON, NULL until known. Local only, never synced.
ALTER TABLE agent_sessions ADD COLUMN context_usage TEXT;
