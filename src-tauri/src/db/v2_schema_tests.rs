//! Rules of the Taido V2 tables (migration 0012), checked in SQL
//! until their repositories arrive (V2.1, V2.3).

use rusqlite::{params, Connection};

use crate::db::{new_id, now_utc, open_in_memory, tasks, test_support};

fn segment(conn: &Connection, task_id: &str, ended_at: Option<&str>) -> rusqlite::Result<usize> {
    let now = now_utc();
    conn.execute(
        "INSERT INTO time_segments (id, task_id, source, started_at, ended_at, \
         created_at, updated_at) VALUES (?1, ?2, 'auto', ?3, ?4, ?3, ?3)",
        params![new_id(), task_id, now, ended_at],
    )
}

fn relation(conn: &Connection, from: &str, to: &str, kind: &str) -> rusqlite::Result<usize> {
    let now = now_utc();
    conn.execute(
        "INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
         updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![new_id(), from, to, kind, now],
    )
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .expect("count")
}

/// One running segment of this Mac's chrono (with a session) per task; a running segment
/// pulled from another Mac (no session here, migration 0016) may run beside it.
#[test]
fn one_running_segment_per_task() {
    let conn = open_in_memory().expect("db");
    let a = test_support::task(&conn, "A", None, None);
    let b = test_support::task(&conn, "B", None, None);
    test_support::claude_terminal(&conn, &a, "ta", "sa", "ca");
    test_support::claude_terminal(&conn, &b, "tb", "sb", "cb");
    let mine = |task: &str, session: &str, ended: Option<&str>| {
        let now = now_utc();
        conn.execute(
            "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
             ended_at, created_at, updated_at) VALUES (?1, ?2, ?3, 'auto', ?4, ?5, ?4, ?4)",
            params![new_id(), task, session, now, ended],
        )
    };
    mine(&a, "sa", None).expect("first running segment");
    assert!(mine(&a, "sa", None).is_err(), "a second running segment");
    mine(&b, "sb", None).expect("another task may run at the same time");
    mine(&a, "sa", Some("2099-01-01T00:00:00.000Z")).expect("closed segments are free");
    segment(&conn, &a, None).expect("another Mac's running segment");
}

#[test]
fn a_segment_cannot_end_before_it_starts() {
    let conn = open_in_memory().expect("db");
    let a = test_support::task(&conn, "A", None, None);
    assert!(segment(&conn, &a, Some("2000-01-01T00:00:00.000Z")).is_err());
}

#[test]
fn relations_refuse_self_links_and_duplicates() {
    let conn = open_in_memory().expect("db");
    let p1 = test_support::subject(&conn, "Summit Events");
    let p2 = test_support::subject(&conn, "Acme Studio");
    let a = test_support::task(&conn, "A", Some(&p1), None);
    let b = test_support::task(&conn, "B", Some(&p2), None);
    relation(&conn, &a, &b, "blocks").expect("across projects");
    assert!(relation(&conn, &a, &a, "blocks").is_err(), "self link");
    assert!(relation(&conn, &a, &b, "blocks").is_err(), "duplicate");
    relation(&conn, &a, &b, "relates_to").expect("another kind");
    assert!(relation(&conn, &a, &b, "parent").is_err(), "unknown kind");
}

#[test]
fn purging_a_task_removes_its_segments_relations_and_attachments() {
    let conn = open_in_memory().expect("db");
    let a = test_support::task(&conn, "A", None, None);
    let b = test_support::task(&conn, "B", None, None);
    segment(&conn, &a, None).expect("segment");
    relation(&conn, &b, &a, "blocks").expect("relation");
    let now = now_utc();
    conn.execute(
        "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
         created_at, updated_at) VALUES (?1, ?2, 'maquette.png', '/tmp/maquette.png', \
         'image/png', 12, ?3, ?3)",
        params![new_id(), a, now],
    )
    .expect("attachment");

    tasks::delete(&conn, &a).expect("delete");
    // The purge takes the tasks deleted more than a day ago.
    crate::db::trash::purge(&conn, chrono::Utc::now() + chrono::Duration::days(2)).expect("purge");

    assert_eq!(count(&conn, "time_segments"), 0);
    assert_eq!(count(&conn, "task_relations"), 0);
    assert_eq!(count(&conn, "attachments"), 0);
}

/// Migration 0021 rebuilds `attachments` (a page may own one): rows, local-only columns and
/// the « exactly one owner » rule survive.
#[test]
fn migration_keeps_existing_attachments() {
    fn outbox_rows(conn: &Connection) -> Vec<(String, String, i64, String, i64)> {
        conn.prepare(
            "SELECT entity, id, seq, changed_at, purged FROM sync_outbox ORDER BY entity, id",
        )
        .expect("prepare")
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("v20.sqlite3");
    let pending;
    {
        let mut conn = Connection::open(&path).expect("open");
        crate::db::MIGRATIONS
            .to_version(&mut conn, 20)
            .expect("migrate to v20");
        conn.execute_batch(
            "INSERT INTO tasks (id, title, position, created_at, updated_at) \
               VALUES ('t', 'T', 1, 'c', 'c');
             INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
               created_at, updated_at, deleted_at, sha256, remote, shared) \
               VALUES ('att', 't', 'a.pdf', '/tmp/a.pdf', 'application/pdf', 3, 'c1', 'u1', \
               'd1', 'abc', 'sent', 1);",
        )
        .expect("seed v20");
        // A pending tombstone, besides the rows the triggers queued for the seed.
        conn.execute(
            "INSERT INTO sync_outbox (entity, id, seq, changed_at, purged) \
             VALUES ('task', 'gone', 99, '2026-10-01T00:00:00.000Z', 1)",
            [],
        )
        .expect("tombstone");
        pending = outbox_rows(&conn);
    }
    let conn = crate::db::open(&path).expect("open and migrate");
    // m6: the outbox rebuilt by 0021 keeps every pending change, tombstones included.
    assert!(pending.len() >= 3, "{pending:?}");
    assert_eq!(outbox_rows(&conn), pending);
    let row: String = conn
        .query_row(
            "SELECT task_id || '|' || ifnull(note_page_id, 'null') || '|' || file_name || '|' \
             || stored_path || '|' || mime_type || '|' || size || '|' || created_at || '|' \
             || updated_at || '|' || deleted_at || '|' || sha256 || '|' || remote || '|' \
             || shared FROM attachments",
            [],
            |r| r.get(0),
        )
        .expect("row");
    assert_eq!(
        row,
        "t|null|a.pdf|/tmp/a.pdf|application/pdf|3|c1|u1|d1|abc|sent|1"
    );
    assert_eq!(
        crate::sync::trigger_count(&conn).expect("count"),
        crate::sync::TRIGGER_COUNT
    );
    // Exactly one owner.
    let both = conn.execute(
        "INSERT INTO attachments (id, file_name, stored_path, mime_type, size, created_at, \
         updated_at) VALUES ('none', 'a', '/tmp/a', 'x/y', 1, 'c', 'c')",
        [],
    );
    assert!(both.is_err(), "an attachment needs an owner");
    conn.execute_batch("PRAGMA foreign_keys = ON").expect("fk");
    assert!(conn
        .execute(
            "INSERT INTO attachments (id, task_id, note_page_id, file_name, stored_path, \
             mime_type, size, created_at, updated_at) VALUES ('two', 't', 'p', 'a', '/tmp/a', \
             'x/y', 1, 'c', 'c')",
            [],
        )
        .is_err());
}
