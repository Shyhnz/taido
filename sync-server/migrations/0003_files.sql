-- Attachment files. One row per attachment that
-- has a file on the server, complete or being uploaded. The bytes live on disk under
-- `<data_dir>/files/<account_id>/<hex sha256(account_id || 0x00 || attachment_id)>` (`.part`
-- while uploading); the bytes received so far are the length of the `.part` file.

CREATE TABLE files (
  account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,                 -- id of the account's `attachment` record
  size          INTEGER NOT NULL,              -- total size declared by the upload, in bytes
  sha256        TEXT NOT NULL,                 -- SHA-256 declared by the upload (64 lowercase hex)
  complete      INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (account_id, attachment_id)
);
