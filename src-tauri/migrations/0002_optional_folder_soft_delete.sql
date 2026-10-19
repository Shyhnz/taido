-- Optional project folder and soft delete:
--   * subjects.root_path becomes nullable (a project may have no folder on disk);
--   * soft delete: deleted_at on subjects and tasks, purged after 24 h.
--
-- SQLite cannot drop a NOT NULL constraint: the subjects table is rebuilt following
-- https://www.sqlite.org/lang_altertable.html#otheralter. The caller turns
-- PRAGMA foreign_keys OFF around the migration (it cannot change inside the transaction),
-- otherwise DROP TABLE would cascade to sections and tasks. PRAGMA foreign_key_check runs
-- before the migration commits (rusqlite_migration `M::foreign_key_check`).

CREATE TABLE subjects_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,                -- palette key
  root_path   TEXT,                         -- absolute path, optional (D5)
  position    REAL NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                          -- soft delete (undo), purged after 24 h
);

INSERT INTO subjects_new (id, name, color, root_path, position, created_at, updated_at)
  SELECT id, name, color, root_path, position, created_at, updated_at FROM subjects;

DROP TABLE subjects;

ALTER TABLE subjects_new RENAME TO subjects;

-- Soft delete (undo), purged after 24 h. Deleting a subject stamps its tasks with the
-- same instant, so that restoring it brings back exactly those tasks.
ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
