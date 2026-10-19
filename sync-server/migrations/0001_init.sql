-- Sync server storage (docs/SYNC.md § 4.2). One account; the server keeps the latest version
-- of every synced row with a monotonic revision. No foreign keys between records: clients
-- check references when they apply (§ 2.5).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 'password_hash': argon2id PHC string, set by `set-password`.
-- 'server_epoch': random UUID inserted at open when absent, renewed by `reset-epoch`.

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the bearer token
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE records (
  entity     TEXT NOT NULL,
  id         TEXT NOT NULL,
  rev        INTEGER NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  data       TEXT,                     -- JSON of SubjectData / SectionData / TaskData / SettingData; NULL = tombstone (never for a setting)
  PRIMARY KEY (entity, id)
);
