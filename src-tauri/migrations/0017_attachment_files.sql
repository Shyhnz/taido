-- Taido V2.7 bis: attachment files travel between
-- devices through the sync server.
-- - `sha256`: lowercase hex SHA-256 of the file, synced (`AttachmentData.sha256`): the update
--   trigger now follows it too. Computed when a file is added; for the attachments made
--   before, by the file job's first pass (SQLite cannot read files). A pulled row carries
--   the hash of the device that has the file; one without keeps the local hash.
-- - `remote`: where this Mac's file stands with the server, local-only (never synced, never
--   tracked): 'local' (the file is here and not on the server yet), 'sent', 'missing' (the row
--   is here, the file is not: to download), 'file_too_large' or 'quota_exceeded' (refused by
--   the server, retried at the next sync). Rows made before start as 'local'; the file job
--   turns those without a file into 'missing'.
ALTER TABLE attachments ADD COLUMN sha256 TEXT;
ALTER TABLE attachments ADD COLUMN remote TEXT NOT NULL DEFAULT 'local'
  CHECK (remote IN ('local', 'sent', 'missing', 'file_too_large', 'quota_exceeded'));

-- Same trigger as 0016_sync_v2.sql, plus `sha256`. `remote` and `stored_path` stay local.
DROP TRIGGER sync_attachments_au;
CREATE TRIGGER sync_attachments_au AFTER UPDATE ON attachments
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.task_id IS NOT NEW.task_id OR OLD.file_name IS NOT NEW.file_name OR
    OLD.mime_type IS NOT NEW.mime_type OR OLD.size IS NOT NEW.size OR
    OLD.deleted_at IS NOT NEW.deleted_at OR OLD.sha256 IS NOT NEW.sha256)
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'attachment' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'attachment', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;
