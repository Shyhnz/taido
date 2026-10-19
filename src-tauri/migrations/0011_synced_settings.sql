-- « Sans projet » as a movable project: shared
-- settings synced between devices (entity 'setting', docs/SYNC.md § 2.1). A separate table
-- keeps local-only settings (`settings`, the sync token among them) apart from synced ones.
CREATE TABLE synced_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,          -- JSON
  updated_at TEXT NOT NULL           -- local write or pulled stamp (diagnostics only)
);

-- `sync_outbox` must accept 'setting': its CHECK cannot be altered, the table is rebuilt.
-- The change-tracking triggers go first (a RENAME while triggers name a missing
-- `sync_outbox` fails, and renaming the old table would rewrite their bodies), then come
-- back verbatim from 0010_sync.sql.
DROP TRIGGER sync_subjects_ai;
DROP TRIGGER sync_subjects_au;
DROP TRIGGER sync_subjects_ad;
DROP TRIGGER sync_sections_ai;
DROP TRIGGER sync_sections_au;
DROP TRIGGER sync_sections_ad;
DROP TRIGGER sync_tasks_ai;
DROP TRIGGER sync_tasks_au;
DROP TRIGGER sync_tasks_ad;

CREATE TABLE sync_outbox_new (
  entity     TEXT NOT NULL CHECK (entity IN ('subject', 'section', 'task', 'setting')),
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

-- subjects: synced columns name, color, parent_id, position, deleted_at.
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
  AND (OLD.name IS NOT NEW.name OR OLD.color IS NOT NEW.color OR
    OLD.parent_id IS NOT NEW.parent_id OR OLD.position IS NOT NEW.position OR
    OLD.deleted_at IS NOT NEW.deleted_at)
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
  AND (OLD.subject_id IS NOT NEW.subject_id OR OLD.name IS NOT NEW.name OR
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

-- tasks: synced columns subject_id, section_id, parent_id, title, description, due_date, due_time, priority, completed_at, position, deleted_at.
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
  AND (OLD.subject_id IS NOT NEW.subject_id OR OLD.section_id IS NOT NEW.section_id OR
    OLD.parent_id IS NOT NEW.parent_id OR OLD.title IS NOT NEW.title OR
    OLD.description IS NOT NEW.description OR OLD.due_date IS NOT NEW.due_date OR
    OLD.due_time IS NOT NEW.due_time OR OLD.priority IS NOT NEW.priority OR
    OLD.completed_at IS NOT NEW.completed_at OR OLD.position IS NOT NEW.position OR
    OLD.deleted_at IS NOT NEW.deleted_at)
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

-- synced_settings: synced column value. Never deleted by the app (a setting has no
-- tombstone); the delete trigger exists so that a manual delete cannot silently desync.
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
  AND OLD.value IS NOT NEW.value
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
