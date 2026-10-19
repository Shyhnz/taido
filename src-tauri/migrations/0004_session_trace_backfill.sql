-- The trace of a Claude session (its prompts and replies) lives in
-- `journal_entries` with its `agent_session_id`. Sessions launched before
-- only have their raw hook events: rebuild their trace from those still kept, so that they
-- show their first message and can be resumed.

INSERT INTO journal_entries (id, task_id, agent_session_id, kind, text, at)
SELECT lower(hex(randomblob(16))), s.task_id, s.id,
       CASE h.event WHEN 'UserPromptSubmit' THEN 'prompt' ELSE 'turn_ended' END,
       substr(CASE h.event
                WHEN 'UserPromptSubmit' THEN json_extract(h.payload, '$.prompt')
                ELSE json_extract(h.payload, '$.last_assistant_message')
              END, 1, 2000),
       h.received_at
FROM hook_events h
JOIN agent_sessions s ON s.claude_session_id = json_extract(h.payload, '$.session_id')
WHERE json_valid(h.payload)
  AND h.event IN ('UserPromptSubmit', 'Stop')
  AND COALESCE(CASE h.event
                 WHEN 'UserPromptSubmit' THEN json_extract(h.payload, '$.prompt')
                 ELSE json_extract(h.payload, '$.last_assistant_message')
               END, '') <> ''
  AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.agent_session_id = s.id
                  AND j.kind IN ('prompt', 'turn_ended'));
