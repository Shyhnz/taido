-- Project notebook: note groups and pages, attachments that may
-- belong to a page instead of a task (`note_attachment` on the wire), the outbox accepting the
-- three new entities and the change-tracking triggers of every synced table (dropped first:
-- a RENAME while triggers name a missing `sync_outbox` fails; recreated on the model of 0016).
CREATE TABLE note_groups (
  id         TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_note_groups_subject ON note_groups(subject_id);

CREATE TABLE note_pages (
  id             TEXT PRIMARY KEY,
  subject_id     TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  group_id       TEXT REFERENCES note_groups(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'summary')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  pinned_at      TEXT,
  position       REAL NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX idx_note_pages_subject ON note_pages(subject_id);
CREATE INDEX idx_note_pages_group ON note_pages(group_id);
CREATE INDEX idx_note_pages_source_task ON note_pages(source_task_id);

-- Triggers first (see above).
DROP TRIGGER sync_subjects_ai;
DROP TRIGGER sync_subjects_au;
DROP TRIGGER sync_subjects_ad;
DROP TRIGGER sync_sections_ai;
DROP TRIGGER sync_sections_au;
DROP TRIGGER sync_sections_ad;
DROP TRIGGER sync_tasks_ai;
DROP TRIGGER sync_tasks_au;
DROP TRIGGER sync_tasks_ad;
DROP TRIGGER sync_synced_settings_ai;
DROP TRIGGER sync_synced_settings_au;
DROP TRIGGER sync_synced_settings_ad;
DROP TRIGGER sync_board_columns_ai;
DROP TRIGGER sync_board_columns_au;
DROP TRIGGER sync_board_columns_ad;
DROP TRIGGER sync_time_segments_ai;
DROP TRIGGER sync_time_segments_au;
DROP TRIGGER sync_time_segments_ad;
DROP TRIGGER sync_task_relations_ai;
DROP TRIGGER sync_task_relations_au;
DROP TRIGGER sync_task_relations_ad;
DROP TRIGGER sync_attachments_ai;
DROP TRIGGER sync_attachments_au;
DROP TRIGGER sync_attachments_ad;

-- attachments: `task_id` becomes optional and `note_page_id` appears (exactly one of the two).
-- Every column of 0012, 0017 and 0018 is kept (`stored_path`, `remote`, `shared` stay local).
CREATE TABLE attachments_new (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  note_page_id TEXT REFERENCES note_pages(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  stored_path  TEXT NOT NULL,                -- absolute path of the copy (never synced)
  mime_type    TEXT NOT NULL,
  size         INTEGER NOT NULL CHECK (size >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  sha256       TEXT,
  remote       TEXT NOT NULL DEFAULT 'local'
    CHECK (remote IN ('local', 'sent', 'missing', 'file_too_large', 'quota_exceeded')),
  shared       INTEGER NOT NULL DEFAULT 0,
  CHECK ((task_id IS NULL) <> (note_page_id IS NULL))
);
INSERT INTO attachments_new (id, task_id, file_name, stored_path, mime_type, size, created_at,
    updated_at, deleted_at, sha256, remote, shared)
  SELECT id, task_id, file_name, stored_path, mime_type, size, created_at, updated_at,
    deleted_at, sha256, remote, shared FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;
CREATE INDEX idx_attachments_task ON attachments(task_id);
CREATE INDEX idx_attachments_note_page ON attachments(note_page_id);

CREATE TABLE sync_outbox_new (
  entity     TEXT NOT NULL CHECK (entity IN ('subject', 'section', 'task', 'setting',
               'board_column', 'time_segment', 'relation', 'attachment',
               'note_group', 'note_page', 'note_attachment')),
  id         TEXT NOT NULL,
  seq        INTEGER NOT NULL,             -- sync_guard.seq at the last change
  changed_at TEXT NOT NULL,                -- canonical UTC: the row's conflict stamp
  purged     INTEGER NOT NULL DEFAULT 0,   -- 1 = hard-deleted: push a tombstone
  PRIMARY KEY (entity, id)
);
INSERT INTO sync_outbox_new (entity, id, seq, changed_at, purged)
  SELECT entity, id, seq, changed_at, purged FROM sync_outbox;
DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_new RENAME TO sync_outbox;
CREATE INDEX idx_sync_outbox_seq ON sync_outbox(seq);

-- subjects: synced columns name, color, parent_id, position, deleted_at, is_group.
CREATE TRIGGER sync_subjects_ai AFTER INSERT ON subjects
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'subject' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'subject', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_subjects_au AFTER UPDATE ON subjects
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.name IS NOT NEW.name OR
    OLD.color IS NOT NEW.color OR
    OLD.parent_id IS NOT NEW.parent_id OR
    OLD.position IS NOT NEW.position OR
    OLD.deleted_at IS NOT NEW.deleted_at OR
    OLD.is_group IS NOT NEW.is_group)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'subject' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'subject', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_subjects_ad AFTER DELETE ON subjects
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'subject' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'subject', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- sections: synced columns subject_id, name, position.
CREATE TRIGGER sync_sections_ai AFTER INSERT ON sections
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'section' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'section', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_sections_au AFTER UPDATE ON sections
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.subject_id IS NOT NEW.subject_id OR
    OLD.name IS NOT NEW.name OR
    OLD.position IS NOT NEW.position)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'section' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'section', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_sections_ad AFTER DELETE ON sections
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'section' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'section', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- tasks: synced columns subject_id, section_id, parent_id, title, description, due_date, due_time, priority, completed_at, position, deleted_at, board_column_id.
CREATE TRIGGER sync_tasks_ai AFTER INSERT ON tasks
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'task' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'task', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_tasks_au AFTER UPDATE ON tasks
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.subject_id IS NOT NEW.subject_id OR
    OLD.section_id IS NOT NEW.section_id OR
    OLD.parent_id IS NOT NEW.parent_id OR
    OLD.title IS NOT NEW.title OR
    OLD.description IS NOT NEW.description OR
    OLD.due_date IS NOT NEW.due_date OR
    OLD.due_time IS NOT NEW.due_time OR
    OLD.priority IS NOT NEW.priority OR
    OLD.completed_at IS NOT NEW.completed_at OR
    OLD.position IS NOT NEW.position OR
    OLD.deleted_at IS NOT NEW.deleted_at OR
    OLD.board_column_id IS NOT NEW.board_column_id)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'task' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'task', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_tasks_ad AFTER DELETE ON tasks
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'task' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'task', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- synced_settings: synced columns value.
CREATE TRIGGER sync_synced_settings_ai AFTER INSERT ON synced_settings
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'setting' AND id = NEW.key),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'setting', NEW.key, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_synced_settings_au AFTER UPDATE ON synced_settings
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.value IS NOT NEW.value)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'setting' AND id = NEW.key),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'setting', NEW.key, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_synced_settings_ad AFTER DELETE ON synced_settings
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'setting' AND id = OLD.key),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'setting', OLD.key, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- board_columns: synced columns subject_id, name, position, is_done.
CREATE TRIGGER sync_board_columns_ai AFTER INSERT ON board_columns
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'board_column' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'board_column', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_board_columns_au AFTER UPDATE ON board_columns
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.subject_id IS NOT NEW.subject_id OR
    OLD.name IS NOT NEW.name OR
    OLD.position IS NOT NEW.position OR
    OLD.is_done IS NOT NEW.is_done)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'board_column' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'board_column', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_board_columns_ad AFTER DELETE ON board_columns
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'board_column' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'board_column', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- time_segments: synced columns task_id, source, started_at, ended_at, stop_reason, note, deleted_at.
CREATE TRIGGER sync_time_segments_ai AFTER INSERT ON time_segments
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'time_segment' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'time_segment', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_time_segments_au AFTER UPDATE ON time_segments
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.task_id IS NOT NEW.task_id OR
    OLD.source IS NOT NEW.source OR
    OLD.started_at IS NOT NEW.started_at OR
    OLD.ended_at IS NOT NEW.ended_at OR
    OLD.stop_reason IS NOT NEW.stop_reason OR
    OLD.note IS NOT NEW.note OR
    OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'time_segment' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'time_segment', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_time_segments_ad AFTER DELETE ON time_segments
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'time_segment' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'time_segment', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- task_relations: synced columns from_task_id, to_task_id, kind, deleted_at.
CREATE TRIGGER sync_task_relations_ai AFTER INSERT ON task_relations
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'relation' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'relation', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_task_relations_au AFTER UPDATE ON task_relations
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.from_task_id IS NOT NEW.from_task_id OR
    OLD.to_task_id IS NOT NEW.to_task_id OR
    OLD.kind IS NOT NEW.kind OR
    OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'relation' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'relation', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_task_relations_ad AFTER DELETE ON task_relations
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'relation' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'relation', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- attachments: synced columns task_id, note_page_id, file_name, mime_type, size, deleted_at, sha256.
CREATE TRIGGER sync_attachments_ai AFTER INSERT ON attachments
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = CASE WHEN NEW.task_id IS NULL THEN 'note_attachment' ELSE 'attachment' END AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT CASE WHEN NEW.task_id IS NULL THEN 'note_attachment' ELSE 'attachment' END, NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_attachments_au AFTER UPDATE ON attachments
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.task_id IS NOT NEW.task_id OR
    OLD.note_page_id IS NOT NEW.note_page_id OR
    OLD.file_name IS NOT NEW.file_name OR
    OLD.mime_type IS NOT NEW.mime_type OR
    OLD.size IS NOT NEW.size OR
    OLD.deleted_at IS NOT NEW.deleted_at OR
    OLD.sha256 IS NOT NEW.sha256)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = CASE WHEN NEW.task_id IS NULL THEN 'note_attachment' ELSE 'attachment' END AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT CASE WHEN NEW.task_id IS NULL THEN 'note_attachment' ELSE 'attachment' END, NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_attachments_ad AFTER DELETE ON attachments
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = CASE WHEN OLD.task_id IS NULL THEN 'note_attachment' ELSE 'attachment' END AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT CASE WHEN OLD.task_id IS NULL THEN 'note_attachment' ELSE 'attachment' END, OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- note_groups: synced columns subject_id, name, position.
CREATE TRIGGER sync_note_groups_ai AFTER INSERT ON note_groups
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'note_group' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'note_group', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_note_groups_au AFTER UPDATE ON note_groups
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.subject_id IS NOT NEW.subject_id OR
    OLD.name IS NOT NEW.name OR
    OLD.position IS NOT NEW.position)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'note_group' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'note_group', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_note_groups_ad AFTER DELETE ON note_groups
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'note_group' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'note_group', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;

-- note_pages: synced columns subject_id, group_id, kind, title, body, source_task_id, pinned_at, position, deleted_at.
CREATE TRIGGER sync_note_pages_ai AFTER INSERT ON note_pages
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'note_page' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'note_page', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_note_pages_au AFTER UPDATE ON note_pages
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.subject_id IS NOT NEW.subject_id OR
    OLD.group_id IS NOT NEW.group_id OR
    OLD.kind IS NOT NEW.kind OR
    OLD.title IS NOT NEW.title OR
    OLD.body IS NOT NEW.body OR
    OLD.source_task_id IS NOT NEW.source_task_id OR
    OLD.pinned_at IS NOT NEW.pinned_at OR
    OLD.position IS NOT NEW.position OR
    OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'note_page' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'note_page', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_note_pages_ad AFTER DELETE ON note_pages
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'note_page' AND id = OLD.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'note_page', OLD.id, seq, last_stamp, 1 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 1;
END;
