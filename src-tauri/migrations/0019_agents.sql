-- Several AI tools: which tool runs each session, and a neutral
-- name for its conversation id (`pending:<uuid>` until Codex announces it).
ALTER TABLE agent_sessions RENAME COLUMN claude_session_id TO conversation_id;
ALTER TABLE agent_sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';
