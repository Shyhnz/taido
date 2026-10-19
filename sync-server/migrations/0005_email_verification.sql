-- Address confirmation at signup. NULL = to confirm; the
-- accounts created before this migration are already in use: confirmed.
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;
UPDATE accounts SET email_verified_at = created_at;

-- One pending confirmation link per account; only the SHA-256 of its token is kept.
CREATE TABLE email_verifications (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
