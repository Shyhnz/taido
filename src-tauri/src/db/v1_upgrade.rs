//! Upgrade of a database written by an earlier version of the app: same data folder, so the
//! user's projects, tasks, notes and sessions stay where they are. The first launch on such a
//! database saves a copy of it, cuts it from the old sync server, then migrates it. Linking to a
//! sync server later re-enqueues every row.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::db::settings::remove;
use crate::error::AppResult;
use crate::sync::store;

/// Name of the database file, the same in V1 and V2.
pub const DB_FILE: &str = "todo-agents.sqlite3";
/// Copy of the V1 database taken before its first migration, beside it. Not in `backups/`:
/// the daily backups prune every file of their own name pattern.
pub const V1_COPY_FILE: &str = "v1-before-v2.sqlite3";
/// Last migration of V1 (branch `v1`): `0011_synced_settings.sql`.
const V1_LAST_SCHEMA: i64 = 11;

/// Opens the database like `db::open`; a V1 database is first copied to `V1_COPY_FILE`
/// and unlinked from V1's server. The link is removed before migrating, so that a launch
/// interrupted after the migration never syncs V2 rows to V1's server.
pub fn open(path: &Path) -> AppResult<Connection> {
    let from_v1 = schema_version(path)?.is_some_and(|v| (1..=V1_LAST_SCHEMA).contains(&v));
    if from_v1 {
        let copy = path.with_file_name(V1_COPY_FILE);
        if !copy.exists() {
            let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            source.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])?;
        }
        let mut conn = Connection::open(path)?;
        let tx = conn.transaction()?;
        forget_server(&tx)?;
        tx.commit()?;
    }
    let mut conn = super::open(path)?;
    if from_v1 {
        unlink_sync(&mut conn)?;
    }
    Ok(conn)
}

/// Schema version of an existing database (`PRAGMA user_version`, written by the
/// migrations), `None` when there is no file yet.
fn schema_version(path: &Path) -> AppResult<Option<i64>> {
    if !path.is_file() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(Some(
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))?,
    ))
}

/// Link and server URL: settings that exist in every schema.
fn forget_server(conn: &Connection) -> AppResult<()> {
    store::clear_link(conn)?;
    remove(conn, store::SERVER_URL)
}

/// Forgets V1's sync server: link, URL, pending changes, known versions and parked rows.
fn unlink_sync(conn: &mut Connection) -> AppResult<()> {
    let tx = conn.transaction()?;
    forget_server(&tx)?;
    tx.execute_batch(
        "DELETE FROM sync_outbox;
         DELETE FROM sync_known;
         DELETE FROM sync_parked;
         UPDATE sync_guard SET applying = 0 WHERE id = 1;",
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::MIGRATIONS;

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).expect("count")
    }

    /// A V1 database (schema 11) with a project, a task and a link to V1's server.
    fn v1_database(path: &Path) {
        let mut conn = Connection::open(path).expect("v1");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        MIGRATIONS
            .to_version(&mut conn, V1_LAST_SCHEMA as usize)
            .expect("v1 schema");
        conn.execute_batch(
            "INSERT INTO subjects (id, name, color, position, created_at, updated_at)
               VALUES ('s1', 'Summit Events', 'blue', 1, '2026-10-01T00:00:00.000Z',
                       '2026-10-01T00:00:00.000Z');
             INSERT INTO settings (key, value) VALUES
               ('sync_server_url', '\"https://taido.example\"'),
               ('sync_token', '\"secret\"'),
               ('sync_device_id', '\"mac\"'),
               ('sync_cursor', '564');",
        )
        .expect("data");
        assert!(count(&conn, "SELECT count(*) FROM sync_outbox") > 0);
    }

    #[test]
    fn upgrades_v1_in_place_keeps_a_copy_and_cuts_the_sync() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(DB_FILE);
        v1_database(&path);

        let conn = open(&path).expect("open");
        assert_eq!(count(&conn, "SELECT count(*) FROM subjects"), 1);
        assert!(!store::is_linked(&conn).expect("linked"));
        assert_eq!(
            crate::db::settings::read::<String>(&conn, store::SERVER_URL).expect("url"),
            None
        );
        assert_eq!(count(&conn, "SELECT count(*) FROM sync_outbox"), 0);
        assert_eq!(count(&conn, "SELECT count(*) FROM sync_known"), 0);
        // The V2 tables exist.
        assert_eq!(count(&conn, "SELECT count(*) FROM time_segments"), 0);

        // The copy is the V1 database, untouched.
        let copy = Connection::open(dir.path().join(V1_COPY_FILE)).expect("copy");
        assert_eq!(count(&copy, "PRAGMA user_version"), V1_LAST_SCHEMA);
        assert_eq!(count(&copy, "SELECT count(*) FROM subjects"), 1);
        assert_eq!(
            count(
                &copy,
                "SELECT count(*) FROM settings WHERE key = 'sync_token'"
            ),
            1
        );
    }

    #[test]
    fn a_v2_database_keeps_its_link() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(DB_FILE);
        drop(open(&path).expect("new database"));
        assert!(!dir.path().join(V1_COPY_FILE).exists());
        {
            let conn = Connection::open(&path).expect("conn");
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('sync_token', '\"v2\"')",
                [],
            )
            .expect("token");
        }
        let conn = open(&path).expect("reopen");
        assert!(store::is_linked(&conn).expect("linked"));
        assert!(!dir.path().join(V1_COPY_FILE).exists());
    }
}
