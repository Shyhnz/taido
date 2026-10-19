-- V2.7 accounts: several accounts, records scoped by account.
-- A legacy database holding an account or records is refused before this migration runs
-- (store::refuse_legacy): only an empty one reaches here, so `devices` and `records` are
-- recreated rather than converted.

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,               -- UUID
  email         TEXT NOT NULL UNIQUE,           -- lowercase, trimmed
  password_hash TEXT NOT NULL,                  -- argon2id PHC string
  created_at    TEXT NOT NULL
);

DELETE FROM meta WHERE key = 'password_hash';

DROP TABLE records;
DROP TABLE devices;

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the bearer token
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX devices_account ON devices (account_id);

-- `rev` stays unique across the whole server: a cursor is a revision of the global log, read
-- through the rows of one account.
CREATE TABLE records (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity     TEXT NOT NULL,
  id         TEXT NOT NULL,
  rev        INTEGER NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  data       TEXT,                     -- JSON of the entity's data; NULL = tombstone (never for a setting)
  PRIMARY KEY (account_id, entity, id)
);
CREATE INDEX records_account_rev ON records (account_id, rev);

-- One active « forgotten password » code per account (task 4).
CREATE TABLE password_resets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
