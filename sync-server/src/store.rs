//! Storage: `<data_dir>/sync.sqlite3` (WAL, foreign keys on), one connection behind a mutex
//! (docs/SYNC.md § 4.2). Accounts, their devices, the record log and the server epoch (`meta`).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};

use crate::error::ServerError;

const MIGRATIONS_SLICE: &[M<'static>] = &[
    M::up(include_str!("../migrations/0001_init.sql")),
    M::up(include_str!("../migrations/0002_accounts.sql")),
    M::up(include_str!("../migrations/0003_files.sql")),
    M::up(include_str!("../migrations/0004_records_bytes.sql")),
    M::up(include_str!("../migrations/0005_email_verification.sql")),
];
const MIGRATIONS: Migrations<'static> = Migrations::from_slice(MIGRATIONS_SLICE);

/// File name of the database inside the data directory.
pub const DB_FILE: &str = "sync.sqlite3";

/// `meta` key of the legacy single password (only read to refuse such a database).
const KEY_PASSWORD_HASH: &str = "password_hash";
const KEY_SERVER_EPOCH: &str = "server_epoch";

/// Current instant, canonical UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).
pub fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Path of the database file in `data_dir`.
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join(DB_FILE)
}

/// Opens (or creates) the database in `data_dir`, runs the migrations and makes sure a
/// `server_epoch` exists. A legacy database in use is refused
/// ([`ServerError::LegacyDatabase`]): the V2 server starts on a new data directory.
pub fn open_connection(data_dir: &Path) -> Result<Connection, ServerError> {
    std::fs::create_dir_all(data_dir)?;
    let mut conn = Connection::open(db_path(data_dir))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    refuse_legacy(&conn)?;
    MIGRATIONS.to_latest(&mut conn)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    ensure_epoch(&conn)?;
    Ok(conn)
}

/// Fails on a database at schema version 1 that holds its password or records.
/// An empty one (server started, never used) is upgraded.
fn refuse_legacy(conn: &Connection) -> Result<(), ServerError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != 1 {
        return Ok(());
    }
    let in_use: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)
             OR EXISTS (SELECT 1 FROM records)",
        [KEY_PASSWORD_HASH],
        |r| r.get(0),
    )?;
    if in_use {
        Err(ServerError::LegacyDatabase)
    } else {
        Ok(())
    }
}

/// In-memory database for unit tests.
#[cfg(test)]
pub fn open_in_memory() -> Result<Connection, ServerError> {
    let mut conn = Connection::open_in_memory()?;
    MIGRATIONS.to_latest(&mut conn)?;
    ensure_epoch(&conn)?;
    Ok(conn)
}

/// The shared connection.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Store, ServerError> {
        Ok(Store {
            conn: Mutex::new(open_connection(data_dir)?),
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Store, ServerError> {
        Ok(Store {
            conn: Mutex::new(open_in_memory()?),
        })
    }

    /// Locks the connection. Blocking: call from `spawn_blocking` in async code.
    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>, ServerError> {
        self.conn.lock().map_err(|_| ServerError::Poisoned)
    }
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, ServerError> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), ServerError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Creates the epoch when absent; returns it.
pub fn ensure_epoch(conn: &Connection) -> Result<String, ServerError> {
    if let Some(epoch) = meta_get(conn, KEY_SERVER_EPOCH)? {
        return Ok(epoch);
    }
    let epoch = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
        params![KEY_SERVER_EPOCH, epoch],
    )?;
    // Another process may have inserted one first: read back the stored value.
    meta_get(conn, KEY_SERVER_EPOCH)?
        .ok_or_else(|| ServerError::Invalid("server epoch missing after insert".into()))
}

/// The database's identity (docs/SYNC.md § 2.6).
pub fn server_epoch(conn: &Connection) -> Result<String, ServerError> {
    ensure_epoch(conn)
}

/// Renews the epoch (run after restoring a backup); returns the new one.
pub fn reset_epoch(conn: &Connection) -> Result<String, ServerError> {
    let epoch = uuid::Uuid::new_v4().to_string();
    meta_set(conn, KEY_SERVER_EPOCH, &epoch)?;
    Ok(epoch)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// What `GET /api/account` shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub created_at: String,
    /// The address was confirmed (link of the signup mail, or a password reset by e-mail).
    pub email_verified: bool,
}

/// What a login needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub id: String,
    pub password_hash: String,
}

/// A row of the `accounts` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSummary {
    pub email: String,
    pub created_at: String,
    /// Devices not revoked.
    pub live_devices: usize,
}

/// Creates an account (`email` already normalised by `auth::normalize_email`); `None` when
/// the address is taken.
pub fn create_account(
    conn: &Connection,
    email: &str,
    password_hash: &str,
) -> Result<Option<String>, ServerError> {
    let id = uuid::Uuid::new_v4().to_string();
    let inserted = conn.execute(
        "INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (email) DO NOTHING",
        params![id, email, password_hash, now_utc()],
    )?;
    Ok((inserted == 1).then_some(id))
}

pub fn account_by_email(
    conn: &Connection,
    email: &str,
) -> Result<Option<Credentials>, ServerError> {
    Ok(conn
        .query_row(
            "SELECT id, password_hash FROM accounts WHERE email = ?1",
            [email],
            |r| {
                Ok(Credentials {
                    id: r.get(0)?,
                    password_hash: r.get(1)?,
                })
            },
        )
        .optional()?)
}

pub fn account_by_id(conn: &Connection, account_id: &str) -> Result<Option<Account>, ServerError> {
    let row: Option<(String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, email, created_at, email_verified_at FROM accounts WHERE id = ?1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(row.map(|(id, email, created_at, verified_at)| Account {
        id,
        email,
        created_at,
        email_verified: verified_at.is_some(),
    }))
}

/// Marks the address of the account confirmed (kept if it already was) and drops its pending
/// confirmation link.
pub fn mark_email_verified(conn: &Connection, account_id: &str) -> Result<(), ServerError> {
    conn.execute(
        "UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, ?1) WHERE id = ?2",
        params![now_utc(), account_id],
    )?;
    conn.execute(
        "DELETE FROM email_verifications WHERE account_id = ?1",
        [account_id],
    )?;
    Ok(())
}

/// Stores the (hashed) confirmation token of an account, replacing any previous one.
pub fn put_email_verification(
    conn: &Connection,
    account_id: &str,
    token_hash: &str,
    expires_at: &str,
) -> Result<(), ServerError> {
    conn.execute(
        "INSERT INTO email_verifications (account_id, token_hash, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id) DO UPDATE SET
           token_hash = excluded.token_hash, expires_at = excluded.expires_at",
        params![account_id, token_hash, expires_at],
    )?;
    Ok(())
}

/// Confirms the address whose pending link has this token hash, if not expired at `now`
/// (same format as [`now_utc`]); returns the address. The link is deleted (used once); an
/// expired one too.
pub fn confirm_email(
    conn: &Connection,
    token_hash: &str,
    now: &str,
) -> Result<Option<String>, ServerError> {
    let tx = conn.unchecked_transaction()?;
    let row: Option<(String, String, String)> = tx
        .query_row(
            "SELECT v.account_id, v.expires_at, a.email FROM email_verifications v
             JOIN accounts a ON a.id = v.account_id WHERE v.token_hash = ?1",
            [token_hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((account_id, expires_at, email)) = row else {
        return Ok(None);
    };
    let confirmed = expires_at.as_str() > now;
    if confirmed {
        mark_email_verified(&tx, &account_id)?;
    } else {
        tx.execute(
            "DELETE FROM email_verifications WHERE account_id = ?1",
            [&account_id],
        )?;
    }
    tx.commit()?;
    Ok(confirmed.then_some(email))
}

/// Stores a new password hash for the account, revokes its devices and drops its pending
/// reset code (one transaction). Returns the number of devices revoked.
pub fn set_password_hash(
    conn: &Connection,
    account_id: &str,
    hash: &str,
) -> Result<usize, ServerError> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE accounts SET password_hash = ?1 WHERE id = ?2",
        params![hash, account_id],
    )?;
    let revoked = tx.execute(
        "UPDATE devices SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
        params![now_utc(), account_id],
    )?;
    tx.execute(
        "DELETE FROM password_resets WHERE account_id = ?1",
        [account_id],
    )?;
    tx.commit()?;
    Ok(revoked)
}

/// [`set_password_hash`] after a code received by e-mail: the address is confirmed too.
pub fn reset_password_hash(
    conn: &Connection,
    account_id: &str,
    hash: &str,
) -> Result<usize, ServerError> {
    let revoked = set_password_hash(conn, account_id, hash)?;
    mark_email_verified(conn, account_id)?;
    Ok(revoked)
}

/// Stores the (hashed) reset code of an account, replacing any previous one; its tries start
/// again from zero.
pub fn put_password_reset(
    conn: &Connection,
    account_id: &str,
    code_hash: &str,
    expires_at: &str,
) -> Result<(), ServerError> {
    conn.execute(
        "INSERT INTO password_resets (account_id, code_hash, expires_at, attempts)
         VALUES (?1, ?2, ?3, 0)
         ON CONFLICT (account_id) DO UPDATE SET
           code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0",
        params![account_id, code_hash, expires_at],
    )?;
    Ok(())
}

/// One try of a reset code (`code_hash` as computed from the code typed). Counts the try,
/// then accepts only a code that is the account's current one, not expired at `now` (same
/// format as [`now_utc`]) and tried at most `max_attempts` times so far, this one included.
/// An accepted code is deleted (used once); an expired one too.
pub fn try_password_reset(
    conn: &Connection,
    account_id: &str,
    code_hash: &str,
    now: &str,
    max_attempts: i64,
) -> Result<bool, ServerError> {
    let tx = conn.unchecked_transaction()?;
    let row: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT code_hash, expires_at, attempts FROM password_resets WHERE account_id = ?1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((stored, expires_at, attempts)) = row else {
        return Ok(false);
    };
    if expires_at.as_str() <= now {
        tx.execute(
            "DELETE FROM password_resets WHERE account_id = ?1",
            [account_id],
        )?;
        tx.commit()?;
        return Ok(false);
    }
    let attempts = attempts.saturating_add(1);
    tx.execute(
        "UPDATE password_resets SET attempts = ?1 WHERE account_id = ?2",
        params![attempts, account_id],
    )?;
    let accepted = attempts <= max_attempts && crate::auth::constant_time_eq(&stored, code_hash);
    if accepted {
        tx.execute(
            "DELETE FROM password_resets WHERE account_id = ?1",
            [account_id],
        )?;
    }
    tx.commit()?;
    Ok(accepted)
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<AccountSummary>, ServerError> {
    let mut stmt = conn.prepare(
        "SELECT a.email, a.created_at,
                (SELECT COUNT(*) FROM devices d
                 WHERE d.account_id = a.id AND d.revoked_at IS NULL)
         FROM accounts a ORDER BY a.created_at, a.email",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (email, created_at, devices) = row?;
        out.push(AccountSummary {
            email,
            created_at,
            live_devices: usize::try_from(devices).unwrap_or(0),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/// A row of the device list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    /// The account's address.
    pub email: String,
    pub name: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// The device and account behind a live token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authed {
    pub device_id: String,
    pub account_id: String,
}

/// Registers a device of `account_id` with the hash of its new token; returns its id.
pub fn create_device(
    conn: &Connection,
    account_id: &str,
    name: &str,
    token_hash: &str,
) -> Result<String, ServerError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_utc();
    conn.execute(
        "INSERT INTO devices (id, account_id, name, token_hash, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, account_id, name, token_hash, now],
    )?;
    Ok(id)
}

/// The live device holding this token hash, with `last_seen_at` refreshed.
pub fn authenticate(conn: &Connection, token_hash: &str) -> Result<Option<Authed>, ServerError> {
    let authed = conn
        .query_row(
            "SELECT id, account_id FROM devices WHERE token_hash = ?1 AND revoked_at IS NULL",
            [token_hash],
            |r| {
                Ok(Authed {
                    device_id: r.get(0)?,
                    account_id: r.get(1)?,
                })
            },
        )
        .optional()?;
    if let Some(authed) = &authed {
        conn.execute(
            "UPDATE devices SET last_seen_at = ?1 WHERE id = ?2",
            params![now_utc(), authed.device_id],
        )?;
    }
    Ok(authed)
}

/// Revokes one device; `false` when it does not exist or was already revoked.
pub fn revoke_device(conn: &Connection, device_id: &str) -> Result<bool, ServerError> {
    let n = conn.execute(
        "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
        params![now_utc(), device_id],
    )?;
    Ok(n > 0)
}

/// Every device, or those of the account with this (normalised) address.
pub fn list_devices(conn: &Connection, email: Option<&str>) -> Result<Vec<Device>, ServerError> {
    let mut stmt = conn.prepare(
        "SELECT d.id, a.email, d.name, d.created_at, d.last_seen_at, d.revoked_at
         FROM devices d JOIN accounts a ON a.id = d.account_id
         WHERE ?1 IS NULL OR a.email = ?1
         ORDER BY a.email, d.created_at, d.id",
    )?;
    let rows = stmt.query_map([email], |r| {
        Ok(Device {
            id: r.get(0)?,
            email: r.get(1)?,
            name: r.get(2)?,
            created_at: r.get(3)?,
            last_seen_at: r.get(4)?,
            revoked_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_existing_before_confirmation_are_confirmed() {
        let mut conn = Connection::open_in_memory().expect("db");
        MIGRATIONS.to_version(&mut conn, 4).expect("to 4");
        conn.execute(
            "INSERT INTO accounts (id, email, password_hash, created_at)
               VALUES ('a', 'a@example.com', 'phc', '2026-10-10T08:00:00.000Z')",
            [],
        )
        .expect("row");
        MIGRATIONS.to_latest(&mut conn).expect("to latest");
        assert!(
            account_by_id(&conn, "a")
                .expect("read")
                .expect("a")
                .email_verified
        );
        let id = create_account(&conn, "b@example.com", "phc")
            .expect("create")
            .expect("new");
        assert!(
            !account_by_id(&conn, &id)
                .expect("read")
                .expect("b")
                .email_verified
        );
    }

    #[test]
    fn the_migration_counts_existing_rows() {
        // Migrated up to 0003, a row is stored, then 0004 runs: the counter matches the row.
        let mut conn = Connection::open_in_memory().expect("db");
        MIGRATIONS.to_version(&mut conn, 3).expect("to 3");
        conn.execute_batch(
            "INSERT INTO accounts (id, email, password_hash, created_at)
               VALUES ('a', 'a@example.com', 'phc', '2026-10-10T08:00:00.000Z');
             INSERT INTO records (account_id, entity, id, rev, updated_at, device_id, data)
               VALUES ('a', 'task', 't', 1, '2026-10-10T08:00:00.000Z', 'd', '{\"title\":\"été\"}');",
        )
        .expect("rows");
        MIGRATIONS.to_latest(&mut conn).expect("to latest");
        let bytes: i64 = conn
            .query_row(
                "SELECT records_bytes FROM accounts WHERE id = 'a'",
                [],
                |r| r.get(0),
            )
            .expect("bytes");
        assert_eq!(
            bytes,
            i64::try_from("{\"title\":\"été\"}".len()).expect("len")
        );
    }

    #[test]
    fn migrations_are_valid() {
        assert!(MIGRATIONS.validate().is_ok());
    }

    #[test]
    fn epoch_is_created_once_and_reset_renews_it() {
        let conn = open_in_memory().expect("db");
        let first = server_epoch(&conn).expect("epoch");
        assert_eq!(first.len(), 36);
        assert_eq!(server_epoch(&conn).expect("epoch"), first);
        let renewed = reset_epoch(&conn).expect("reset");
        assert_ne!(renewed, first);
        assert_eq!(server_epoch(&conn).expect("epoch"), renewed);
    }

    #[test]
    fn epoch_survives_reopen_and_reset_on_disk() {
        let dir = tempfile::tempdir().expect("tmp");
        let first = {
            let conn = open_connection(dir.path()).expect("open");
            server_epoch(&conn).expect("epoch")
        };
        let conn = open_connection(dir.path()).expect("reopen");
        assert_eq!(server_epoch(&conn).expect("epoch"), first);
        let journal: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .expect("pragma");
        assert_eq!(journal, "wal");
    }

    fn account(conn: &Connection, email: &str) -> String {
        create_account(conn, email, "phc")
            .expect("create")
            .expect("new account")
    }

    #[test]
    fn accounts_are_unique_by_email() {
        let conn = open_in_memory().expect("db");
        let id = account(&conn, "alice@example.com");
        assert_eq!(
            create_account(&conn, "alice@example.com", "other").expect("create"),
            None,
            "address already taken"
        );
        let found = account_by_email(&conn, "alice@example.com")
            .expect("lookup")
            .expect("found");
        assert_eq!(found.id, id);
        assert_eq!(found.password_hash, "phc");
        let account = account_by_id(&conn, &id).expect("read").expect("found");
        assert_eq!(account.email, "alice@example.com");
        assert!(account_by_email(&conn, "nobody@example.com")
            .expect("lookup")
            .is_none());
    }

    #[test]
    fn account_password_change_revokes_only_its_devices() {
        let conn = open_in_memory().expect("db");
        let user = account(&conn, "alice@example.com");
        let other = account(&conn, "other@example.com");
        create_device(&conn, &user, "Mac", "hash-a").expect("device");
        create_device(&conn, &user, "Téléphone", "hash-b").expect("device");
        let kept = create_device(&conn, &other, "Mac", "hash-c").expect("device");
        let authed = authenticate(&conn, "hash-a").expect("auth").expect("live");
        assert_eq!(authed.account_id, user);
        assert_eq!(set_password_hash(&conn, &user, "new").expect("set"), 2);
        assert_eq!(
            account_by_email(&conn, "alice@example.com")
                .expect("lookup")
                .expect("found")
                .password_hash,
            "new"
        );
        assert!(authenticate(&conn, "hash-a").expect("auth").is_none());
        assert!(authenticate(&conn, "hash-b").expect("auth").is_none());
        assert_eq!(
            authenticate(&conn, "hash-c")
                .expect("auth")
                .map(|a| a.device_id),
            Some(kept)
        );
    }

    #[test]
    fn reset_code_is_tried_five_times_at_most_and_used_once() {
        let conn = open_in_memory().expect("db");
        let id = account(&conn, "a@b.co");
        let now = "2026-10-10T10:00:00.000Z";
        let later = "2026-10-10T10:30:00.000Z";
        assert!(!try_password_reset(&conn, &id, "h", now, 5).expect("no code"));
        put_password_reset(&conn, &id, "good", later).expect("put");
        for _ in 0..4 {
            assert!(!try_password_reset(&conn, &id, "bad", now, 5).expect("try"));
        }
        assert!(try_password_reset(&conn, &id, "good", now, 5).expect("fifth try"));
        assert!(!try_password_reset(&conn, &id, "good", now, 5).expect("used"));

        put_password_reset(&conn, &id, "good", later).expect("put");
        for _ in 0..5 {
            assert!(!try_password_reset(&conn, &id, "bad", now, 5).expect("try"));
        }
        assert!(!try_password_reset(&conn, &id, "good", now, 5).expect("sixth try"));
        // A new code starts again from zero tries.
        put_password_reset(&conn, &id, "new", later).expect("put");
        assert!(try_password_reset(&conn, &id, "new", now, 5).expect("new code"));

        put_password_reset(&conn, &id, "good", now).expect("put");
        assert!(!try_password_reset(&conn, &id, "good", now, 5).expect("expired"));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM password_resets", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 0, "expired code deleted");

        put_password_reset(&conn, &id, "good", later).expect("put");
        set_password_hash(&conn, &id, "hash").expect("set");
        assert!(!try_password_reset(&conn, &id, "good", now, 5).expect("dropped"));
    }

    #[test]
    fn accounts_listing_counts_live_devices() {
        let conn = open_in_memory().expect("db");
        let user = account(&conn, "alice@example.com");
        account(&conn, "other@example.com");
        let a = create_device(&conn, &user, "Mac", "hash-a").expect("device");
        create_device(&conn, &user, "Téléphone", "hash-b").expect("device");
        revoke_device(&conn, &a).expect("revoke");
        let accounts = list_accounts(&conn).expect("list");
        let counts: Vec<(&str, usize)> = accounts
            .iter()
            .map(|a| (a.email.as_str(), a.live_devices))
            .collect();
        assert_eq!(counts, [("alice@example.com", 1), ("other@example.com", 0)]);
    }

    #[test]
    fn revoke_and_list_devices() {
        let conn = open_in_memory().expect("db");
        let user = account(&conn, "alice@example.com");
        let other = account(&conn, "other@example.com");
        let a = create_device(&conn, &user, "Mac", "hash-a").expect("device");
        create_device(&conn, &other, "PC", "hash-b").expect("device");
        assert!(revoke_device(&conn, &a).expect("revoke"));
        assert!(!revoke_device(&conn, &a).expect("revoke again"));
        assert!(!revoke_device(&conn, "nope").expect("unknown"));
        assert_eq!(list_devices(&conn, None).expect("list").len(), 2);
        let devices = list_devices(&conn, Some("alice@example.com")).expect("list");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Mac");
        assert_eq!(devices[0].email, "alice@example.com");
        assert!(devices[0].revoked_at.is_some());
    }

    /// A data dir holding a legacy database (only `0001_init.sql` applied).
    fn legacy_dir(seed: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tmp");
        let mut conn = Connection::open(db_path(dir.path())).expect("open");
        Migrations::from_slice(&MIGRATIONS_SLICE[..1])
            .to_latest(&mut conn)
            .expect("legacy schema");
        conn.execute_batch(seed).expect("seed");
        dir
    }

    #[test]
    fn a_legacy_database_is_refused() {
        for seed in [
            "INSERT INTO meta (key, value) VALUES ('password_hash', 'phc')",
            "INSERT INTO records (entity, id, rev, updated_at, device_id, data)
             VALUES ('task', 't1', 1, '2026-10-01T08:00:00.000Z', 'd1', NULL)",
        ] {
            let dir = legacy_dir(seed);
            let err = open_connection(dir.path()).expect_err("refused");
            assert!(matches!(err, ServerError::LegacyDatabase), "{err}");
            assert!(err.to_string().contains("legacy"), "{err}");
        }
    }

    #[test]
    fn an_empty_legacy_database_is_upgraded() {
        let dir = legacy_dir("INSERT INTO meta (key, value) VALUES ('server_epoch', 'e')");
        let conn = open_connection(dir.path()).expect("upgraded");
        assert_eq!(server_epoch(&conn).expect("epoch"), "e");
        account(&conn, "alice@example.com");
    }
}
