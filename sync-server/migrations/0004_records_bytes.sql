-- Bytes of the account's stored row data (`records.data`), kept
-- up to date by each push and checked against TAIDO_RECORDS_QUOTA_BYTES. Rust counts
-- `String::len` (UTF-8 bytes), the same as LENGTH(CAST(… AS BLOB)) on a UTF-8 database.
ALTER TABLE accounts ADD COLUMN records_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE accounts SET records_bytes = (
  SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) FROM records
  WHERE records.account_id = accounts.id
);
