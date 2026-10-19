-- Taido V2.2 (2026-10-09): the kanban's columns are the progress of the tasks, not
-- Claude's states. Each project (and « Sans projet », `subject_id` NULL) has its own ordered
-- columns, created on first use with « À faire · En cours · À valider · Terminé ». The done
-- column (`is_done`) is always last and holds the completed tasks. A task without column, or
-- whose column belongs to another project, is in the first column. Not synced yet (V2.7).

CREATE TABLE board_columns (
  id         TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE CASCADE,   -- NULL = « Sans projet »
  name       TEXT NOT NULL,
  position   REAL NOT NULL,
  is_done    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_board_columns_subject ON board_columns(subject_id, position);

ALTER TABLE tasks ADD COLUMN board_column_id TEXT
  REFERENCES board_columns(id) ON DELETE SET NULL;
