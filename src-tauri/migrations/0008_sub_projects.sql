-- A project may hold projects, one level only (Globex › Client).
--
-- `parent_id` names the top-level project of a sub-project (NULL for a top-level project).
-- One level is enforced by the core (`db::subjects`), not by the schema. Positions are
-- scoped per parent: a sub-project's position orders it among its siblings.
--
-- A column with a REFERENCES clause and a NULL default can be added in place
-- (https://www.sqlite.org/lang_altertable.html#altertabaddcol): no table rebuild, the
-- sections and tasks that reference `subjects` are untouched. Deleting a parent for good
-- (purge, 24 h after a soft delete that stamped its sub-projects at the same instant)
-- takes its sub-projects with it.

ALTER TABLE subjects ADD COLUMN parent_id TEXT REFERENCES subjects(id) ON DELETE CASCADE;
CREATE INDEX idx_subjects_parent ON subjects(parent_id, position) WHERE parent_id IS NOT NULL;
