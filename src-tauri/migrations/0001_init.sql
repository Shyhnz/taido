-- Initial schema.
-- PRAGMA foreign_keys = ON is set when each connection is opened:
-- it has no effect inside a migration running in a transaction.

CREATE TABLE subjects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,                -- palette key
  root_path   TEXT NOT NULL,                -- absolute path
  position    REAL NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sections (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  subpath     TEXT,                         -- relative to the subject folder
  position    REAL NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  subject_id       TEXT REFERENCES subjects(id) ON DELETE CASCADE,   -- NULL = inbox
  section_id       TEXT REFERENCES sections(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  due_date         TEXT,                    -- 'YYYY-MM-DD', local time
  due_time         TEXT,                    -- 'HH:MM'
  workdir_override TEXT,                    -- absolute path
  completed_at     TEXT,
  position         REAL NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_tasks_place ON tasks(subject_id, section_id, position);
CREATE INDEX idx_tasks_due   ON tasks(due_date) WHERE completed_at IS NULL;

CREATE TABLE subtasks (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE terminals (                    -- one process launch
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('claude','shell','command')),
  command        TEXT,                      -- for kind = 'command'
  cwd            TEXT NOT NULL,
  label          TEXT,
  position       REAL NOT NULL,
  opened_at      TEXT NOT NULL,
  closed_at      TEXT,
  exit_code      INTEGER,
  closed_by_user INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_terminals_task ON terminals(task_id);

CREATE TABLE agent_sessions (               -- one Claude Code conversation
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  claude_session_id   TEXT NOT NULL UNIQUE,
  current_terminal_id TEXT REFERENCES terminals(id) ON DELETE SET NULL,
  state               TEXT NOT NULL,        -- starting|idle|working|waiting|done|error|paused|crashed
  waiting_kind        TEXT,                 -- permission|question|input
  error_kind          TEXT,                 -- StopFailure error type
  activity            TEXT,                 -- e.g. "Édition src/…"
  last_message        TEXT,                 -- Claude's last message (Stop)
  pending_permission  TEXT,                 -- JSON { tool_name, summary } of the first pending request
  permission_mode     TEXT,                 -- mode chosen at launch, passed again on resume
  add_task_context    INTEGER NOT NULL DEFAULT 1,
  ended_cleanly       INTEGER NOT NULL DEFAULT 0,
  state_changed_at    TEXT NOT NULL,        -- entered the current state ("since…", ⌘J)
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  ended_at            TEXT                  -- process exit or end of the conversation
);
CREATE INDEX idx_sessions_task ON agent_sessions(task_id, updated_at);
CREATE UNIQUE INDEX idx_sessions_terminal ON agent_sessions(current_terminal_id)
  WHERE current_terminal_id IS NOT NULL;    -- at most one current session per terminal

CREATE TABLE journal_entries (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,
  -- created|note|session_started|prompt|turn_ended|waiting|error|session_ended|crashed|resumed|cleared|compacted|completed|reopened
  text             TEXT NOT NULL,
  at               TEXT NOT NULL
);
CREATE INDEX idx_journal_task ON journal_entries(task_id, at DESC);

CREATE TABLE hook_events (                  -- diagnostics: purged after 7 days or 10,000 rows
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  terminal_id TEXT,
  event       TEXT NOT NULL,
  payload     TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON
);
