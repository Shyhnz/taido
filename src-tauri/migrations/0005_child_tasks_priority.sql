-- A subtask becomes a child task (one level only), with its own
-- panel, terminals and sessions; every task gets a priority from 1 (default) to 4.
--
-- Each row of `subtasks` becomes a task with the same id, under its parent:
--   * same project and section as the parent, title = the subtask's text, no description;
--   * position, created_at and updated_at kept;
--   * done → completed_at = the subtask's updated_at (the instant it was last toggled);
--   * deleted_at = the parent's (a subtask of a deleted task comes back with it, as the
--     tasks of a deleted project do).
-- The `subtasks` table is then dropped: nothing reads it any more.
--
-- Runs with foreign keys off (see `db::migrate`); `PRAGMA foreign_key_check` runs before
-- the migration commits.

ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 1
  CHECK (priority BETWEEN 1 AND 4);
CREATE INDEX idx_tasks_parent ON tasks(parent_id, position) WHERE parent_id IS NOT NULL;

INSERT INTO tasks (id, subject_id, section_id, parent_id, title, description, due_date,
                   due_time, workdir_override, completed_at, position, created_at,
                   updated_at, deleted_at, priority)
SELECT st.id, t.subject_id, t.section_id, t.id, st.text, '', NULL, NULL, NULL,
       CASE WHEN st.done <> 0 THEN st.updated_at END,
       st.position, st.created_at, st.updated_at, t.deleted_at, 1
FROM subtasks st JOIN tasks t ON t.id = st.task_id;

DROP TABLE subtasks;
