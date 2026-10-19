-- Taido V2.1 (chrono): the reasons a running segment stops follow the existing session
-- states. `turn_ended` is added (Claude finished, was interrupted or failed, the session
-- stays open); `manual` is dropped (a manual segment is never running, so never stopped).
-- Nothing wrote to `time_segments` before this migration: the table is rebuilt empty.

DROP TABLE time_segments;

CREATE TABLE time_segments (                -- one stretch of time spent on a task
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,  -- NULL = manual
  source           TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  started_at       TEXT NOT NULL,
  ended_at         TEXT,                    -- NULL = running
  stop_reason      TEXT CHECK (stop_reason IN
                     ('waiting', 'turn_ended', 'session_closed', 'task_done', 'app_closed')),
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- At most one running segment per task (several tasks may run at once).
CREATE UNIQUE INDEX idx_segments_open ON time_segments(task_id)
  WHERE ended_at IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_segments_task ON time_segments(task_id, started_at);
CREATE INDEX idx_segments_started ON time_segments(started_at);
