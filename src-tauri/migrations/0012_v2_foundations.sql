-- Foundations: time tracking (F4), relations between tasks
-- (F5) and attachments (F3). Created empty; their repositories come later, with the features that
-- use them. Every row has a UUID, `updated_at` and a soft delete (`deleted_at`)
-- like the synced tables; the account (`user_id`) only lives on the server.

CREATE TABLE time_segments (                -- one stretch of time spent on a task
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,  -- NULL = manual
  source           TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  started_at       TEXT NOT NULL,
  ended_at         TEXT,                    -- NULL = running
  stop_reason      TEXT CHECK (stop_reason IN
                     ('waiting', 'session_closed', 'task_done', 'app_closed', 'manual')),
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

CREATE TABLE task_relations (               -- « Bloque » (read backwards: « Bloquée par »), « Liée à »
  id           TEXT PRIMARY KEY,
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('blocks', 'relates_to')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  CHECK (from_task_id <> to_task_id)
);
CREATE UNIQUE INDEX idx_relations_pair ON task_relations(from_task_id, to_task_id, kind)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_relations_to ON task_relations(to_task_id);

CREATE TABLE attachments (                  -- a file copied into the task's folder
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  stored_path TEXT NOT NULL,                -- absolute path of the copy (never synced)
  mime_type   TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_attachments_task ON attachments(task_id);
