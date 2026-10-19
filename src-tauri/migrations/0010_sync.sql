-- Change tracking for the sync (docs/SYNC.md § 3). Triggers record every
-- change of a synced column of subjects / sections / tasks in `sync_outbox`, unless the
-- change comes from applying the server's rows (`sync_guard.applying = 1`). Hard deletes
-- (sections, purges, cascades) leave a tombstone (`purged = 1`). Foreign-key actions fire
-- these triggers too (ON DELETE CASCADE / SET NULL).
--
-- The stamp of a change is monotonic (docs/SYNC.md § 2.6):
-- max(now, the device's last stamp + 1 ms, the row's known version + 1 ms).

CREATE TABLE sync_guard (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  applying   INTEGER NOT NULL DEFAULT 0,   -- 1 only while applying pulled rows
  seq        INTEGER NOT NULL DEFAULT 0,   -- change counter
  last_stamp TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'  -- device's last stamp (§ 2.6)
);
INSERT INTO sync_guard (id) VALUES (1);

CREATE TABLE sync_outbox (
  entity     TEXT NOT NULL CHECK (entity IN ('subject', 'section', 'task')),
  id         TEXT NOT NULL,
  seq        INTEGER NOT NULL,             -- sync_guard.seq at the last change
  changed_at TEXT NOT NULL,                -- canonical UTC: the row's conflict stamp
  purged     INTEGER NOT NULL DEFAULT 0,   -- 1 = hard-deleted: push a tombstone
  PRIMARY KEY (entity, id)
);
CREATE INDEX idx_sync_outbox_seq ON sync_outbox(seq);

CREATE TABLE sync_known (                  -- latest version seen of each row (§ 2.6)
  entity TEXT NOT NULL, id TEXT NOT NULL, stamp TEXT NOT NULL,
  PRIMARY KEY (entity, id)
);

CREATE TABLE sync_parked (                 -- pulled rows waiting for a parent (§ 2.5)
  entity TEXT NOT NULL, id TEXT NOT NULL,
  change TEXT NOT NULL,                    -- JSON of the sync_proto::Change
  PRIMARY KEY (entity, id)
);
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
