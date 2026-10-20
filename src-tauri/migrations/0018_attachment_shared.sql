-- Whether the content of an attachment's hash may be on another
-- device (local-only, never synced, not followed by the sync triggers). 1 when the row came
-- from another device or the file was complete on the server once (sent from here, found
-- there, downloaded). A copy edited in place before it was ever sent (0) is the only content
-- of its attachment: the file job hashes it again and sends it. Once shared (1), an edited
-- copy stays local and the attachment's file is fetched next to it (docs/SYNC.md § 0.13).
ALTER TABLE attachments ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
UPDATE attachments SET shared = 1 WHERE remote IN ('sent', 'missing');
