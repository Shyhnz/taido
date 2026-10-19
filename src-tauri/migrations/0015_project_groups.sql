-- Taido V2.2 bis (2026-10-09): no more sub-projects. Projects are flat, like Todoist;
-- a group (`is_group`, top level) only gathers projects in the sidebar, like Brave's tab
-- groups: a name, a color, folded or not. A group holds no task, no section, no folder of its
-- own. Its projects keep `parent_id` = the group (the sub-project machinery: order, fold,
-- delete and restore).
--
-- Conversion: every live top-level project with live sub-projects becomes a group. One that
-- still holds live tasks stays a project: a new group of the same name (id `grp-<its id>`)
-- takes its place, with it and its former sub-projects inside.

ALTER TABLE subjects ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0;

INSERT INTO subjects (id, name, color, root_path, position, created_at, updated_at,
                      parent_id, is_group)
SELECT 'grp-' || p.id, p.name, p.color, NULL, p.position,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 1
FROM subjects p
WHERE p.parent_id IS NULL AND p.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM subjects c WHERE c.parent_id = p.id AND c.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.subject_id = p.id AND t.deleted_at IS NULL);

-- Their sub-projects, then the project itself, move into the new group.
UPDATE subjects SET parent_id = 'grp-' || parent_id
WHERE 'grp-' || parent_id IN (SELECT id FROM subjects WHERE is_group = 1);
UPDATE subjects SET parent_id = 'grp-' || id
WHERE parent_id IS NULL AND 'grp-' || id IN (SELECT id FROM subjects WHERE is_group = 1);

-- The other parents become groups themselves.
UPDATE subjects SET is_group = 1
WHERE parent_id IS NULL AND deleted_at IS NULL AND is_group = 0
  AND EXISTS (SELECT 1 FROM subjects c WHERE c.parent_id = subjects.id AND c.deleted_at IS NULL);
