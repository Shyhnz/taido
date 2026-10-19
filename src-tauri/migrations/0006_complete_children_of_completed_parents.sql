-- Like Todoist, a completed parent has completed children. Subtasks
-- left unchecked under an already completed task (converted by 0005) are completed at their
-- parent's instant.
UPDATE tasks
SET completed_at = (SELECT p.completed_at FROM tasks p WHERE p.id = tasks.parent_id)
WHERE completed_at IS NULL
  AND deleted_at IS NULL
  AND parent_id IN (SELECT id FROM tasks WHERE completed_at IS NOT NULL);
