-- A session of the history can be renamed by the user
-- (`title`), and gets a one-line recap written by Claude Haiku once it ended (`ai_summary`).
ALTER TABLE agent_sessions ADD COLUMN title TEXT;
ALTER TABLE agent_sessions ADD COLUMN ai_summary TEXT;
