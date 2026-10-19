//! Migrations 0010, 0011 and 0016: the change-tracking triggers (docs/SYNC.md § 3.1).

use rusqlite::Connection;

use crate::db::test_support::{self, section, subject, task};
use crate::db::{open_in_memory, sections, subjects, synced_settings, tasks, MIGRATIONS};
use crate::model::{SetCompletedInput, UpdateTaskInput};
use crate::sync::{store, trigger_count, TRIGGER_COUNT};

fn seq(conn: &Connection) -> i64 {
    store::seq(conn).expect("seq")
}

fn entry(conn: &Connection, entity: &str, id: &str) -> Option<(i64, String, bool)> {
    conn.query_row(
        "SELECT seq, changed_at, purged FROM sync_outbox WHERE entity = ?1 AND id = ?2",
        [entity, id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .ok()
}

#[test]
fn the_thirty_triggers_exist_after_all_migrations() {
    let conn = open_in_memory().expect("db");
    assert_eq!(trigger_count(&conn).expect("count"), TRIGGER_COUNT);
    let names: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
            .expect("prepare");
        let rows = stmt.query_map([], |r| r.get(0)).expect("query");
        rows.collect::<Result<_, _>>().expect("rows")
    };
    assert_eq!(TRIGGER_COUNT, 30);
    for table in [
        "subjects",
        "sections",
        "tasks",
        "synced_settings",
        "board_columns",
        "time_segments",
        "task_relations",
        "attachments",
        "note_groups",
        "note_pages",
    ] {
        for suffix in ["ai", "au", "ad"] {
            let name = format!("sync_{table}_{suffix}");
            assert!(names.contains(&name), "missing {name}");
        }
    }
}

#[test]
fn triggers_record_inserts_updates_and_deletes() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Alpha");
    let sec = section(&conn, &s, "Front");
    let t = task(&conn, "Write", Some(&s), Some(&sec));
    assert!(entry(&conn, "subject", &s).is_some_and(|e| !e.2));
    assert!(entry(&conn, "section", &sec).is_some_and(|e| !e.2));
    let (first_seq, first_stamp, _) = entry(&conn, "task", &t).expect("task recorded");

    // Update of a synced column.
    tasks::update(
        &conn,
        &UpdateTaskInput {
            id: t.clone(),
            title: Some("Rewrite".into()),
            description: None,
        },
    )
    .expect("update");
    let (seq2, stamp2, _) = entry(&conn, "task", &t).expect("task");
    assert!(seq2 > first_seq);
    assert!(stamp2 > first_stamp);

    // Completion, then soft delete.
    tasks::set_completed(
        &conn,
        &SetCompletedInput {
            id: t.clone(),
            completed: true,
        },
    )
    .expect("complete");
    let (seq3, _, _) = entry(&conn, "task", &t).expect("task");
    assert!(seq3 > seq2);
    tasks::delete(&conn, &t).expect("soft delete");
    let (seq4, _, purged) = entry(&conn, "task", &t).expect("task");
    assert!(seq4 > seq3);
    assert!(!purged, "a soft delete is an update");

    // Hard delete of a section: tombstone, and the task's section is cleared (SET NULL).
    let before = entry(&conn, "task", &t).expect("task").0;
    sections::delete(&conn, &sec).expect("delete section");
    assert!(entry(&conn, "section", &sec).is_some_and(|e| e.2));
    assert!(entry(&conn, "task", &t).expect("task").0 > before);

    // Hard delete of the project cascades: tombstones for its tasks too.
    let t2 = task(&conn, "Other", Some(&s), None);
    let child = tasks::create_child(&conn, &t2, "Child").expect("child");
    conn.execute("DELETE FROM subjects WHERE id = ?1", [&s])
        .expect("purge");
    assert!(entry(&conn, "subject", &s).is_some_and(|e| e.2));
    assert!(entry(&conn, "task", &t2).is_some_and(|e| e.2));
    assert!(entry(&conn, "task", &child).is_some_and(|e| e.2));
}

#[test]
fn triggers_ignore_local_only_columns_and_updated_at() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Alpha");
    let sec = section(&conn, &s, "Front");
    let t = task(&conn, "Write", Some(&s), Some(&sec));
    let before = seq(&conn);
    conn.execute_batch(&format!(
        "UPDATE subjects SET root_path = '/tmp/else', updated_at = 'x' WHERE id = '{s}';
         UPDATE sections SET subpath = 'web', updated_at = 'x' WHERE id = '{sec}';
         UPDATE tasks SET workdir_override = '/tmp/w', updated_at = 'x' WHERE id = '{t}';
         UPDATE tasks SET title = title WHERE id = '{t}';"
    ))
    .expect("local-only writes");
    assert_eq!(seq(&conn), before);
}

#[test]
fn triggers_ignore_writes_while_applying() {
    let conn = open_in_memory().expect("db");
    store::set_applying(&conn, true).expect("applying");
    let s = subject(&conn, "Alpha");
    let t = task(&conn, "Write", Some(&s), None);
    subjects::delete(&conn, &s).expect("soft delete");
    conn.execute("DELETE FROM tasks WHERE id = ?1", [&t])
        .expect("delete");
    store::set_applying(&conn, false).expect("done");
    assert_eq!(seq(&conn), 0);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
        .expect("count");
    assert_eq!(n, 0);
}

#[test]
fn stamps_are_monotonic() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Alpha");
    // A row known at a future stamp: its next change is stamped one millisecond later.
    let future = "2099-01-01T00:00:00.000Z";
    store::set_known(&conn, "subject", &s, future).expect("known");
    conn.execute("UPDATE subjects SET name = 'Beta' WHERE id = ?1", [&s])
        .expect("rename");
    let (_, stamp, _) = entry(&conn, "subject", &s).expect("subject");
    assert_eq!(stamp, "2099-01-01T00:00:00.001Z");
    // The device's last stamp follows: a later change elsewhere is after it too.
    let t = task(&conn, "Write", None, None);
    let (_, task_stamp, _) = entry(&conn, "task", &t).expect("task");
    assert_eq!(task_stamp, "2099-01-01T00:00:00.002Z");

    // Two rows changed by one statement get strictly increasing stamps.
    let conn = open_in_memory().expect("db");
    let a = task(&conn, "A", None, None);
    let b = task(&conn, "B", None, None);
    conn.execute("UPDATE tasks SET priority = 3", [])
        .expect("update both");
    let (_, sa, _) = entry(&conn, "task", &a).expect("a");
    let (_, sb, _) = entry(&conn, "task", &b).expect("b");
    assert_ne!(sa, sb);
    assert!(sync_proto::is_canonical_timestamp(&sa));
    assert!(sync_proto::is_canonical_timestamp(&sb));
}

/// Migration 0011 on a database at schema 0010: the outbox is rebuilt with its rows, the
/// nine triggers still record changes, and the outbox accepts settings.
#[test]
fn migration_0011_keeps_the_outbox_and_the_triggers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("v10.sqlite3");
    {
        let mut conn = Connection::open(&path).expect("open");
        MIGRATIONS
            .to_version(&mut conn, 10)
            .expect("migrate to v10");
        conn.execute_batch(
            "INSERT INTO subjects (id, name, color, position, created_at, updated_at)
               VALUES ('s1', 'Alpha', 'teal', 1, 't', 't');
             INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
               VALUES ('task', 'gone', 7, '2026-01-01T00:00:00.000Z', 1);",
        )
        .expect("seed v10");
        assert!(
            conn.execute(
                "INSERT INTO sync_outbox (entity, id, seq, changed_at) \
                 VALUES ('setting', 'k', 1, 'x')",
                [],
            )
            .is_err(),
            "v10 refuses settings"
        );
    }
    let conn = crate::db::open(&path).expect("open and migrate");
    assert_eq!(trigger_count(&conn).expect("count"), TRIGGER_COUNT);
    assert!(entry(&conn, "subject", "s1").is_some_and(|e| !e.2));
    assert_eq!(
        entry(&conn, "task", "gone"),
        Some((7, "2026-01-01T00:00:00.000Z".into(), true))
    );
    let index: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_sync_outbox_seq'",
            [],
            |r| r.get(0),
        )
        .expect("index");
    assert_eq!(index, 1);
    // The old triggers still feed the rebuilt outbox.
    let before = seq(&conn);
    conn.execute("UPDATE subjects SET name = 'Beta' WHERE id = 's1'", [])
        .expect("rename");
    assert!(entry(&conn, "subject", "s1").is_some_and(|e| e.0 > before));
    let t = task(&conn, "New", Some("s1"), None);
    assert!(entry(&conn, "task", &t).is_some());
    synced_settings::set_inbox_position(&conn, 2.0).expect("setting");
    assert!(entry(&conn, "setting", synced_settings::INBOX_POSITION).is_some());
}

#[test]
fn synced_settings_writes_are_queued_unless_equal_or_applied() {
    let conn = open_in_memory().expect("db");
    let key = synced_settings::INBOX_POSITION;
    synced_settings::set_inbox_position(&conn, 2.0).expect("insert");
    let (first_seq, first_stamp, purged) = entry(&conn, "setting", key).expect("queued");
    assert!(!purged);
    // An equal write changes nothing (no update, no trigger).
    synced_settings::set_inbox_position(&conn, 2.0).expect("same");
    assert_eq!(seq(&conn), first_seq);
    synced_settings::set_inbox_position(&conn, 3.0).expect("update");
    let (second_seq, second_stamp, _) = entry(&conn, "setting", key).expect("queued");
    assert!(second_seq > first_seq);
    assert!(second_stamp > first_stamp);
    // A write while applying pulled rows is not a local change.
    conn.execute("DELETE FROM sync_outbox", []).expect("clear");
    store::set_applying(&conn, true).expect("applying");
    synced_settings::set(&conn, "theme_x", &serde_json::json!("dark")).expect("insert");
    synced_settings::set_inbox_position(&conn, 4.0).expect("update");
    store::set_applying(&conn, false).expect("done");
    assert_eq!(seq(&conn), second_seq);
    assert_eq!(entry(&conn, "setting", key), None);
    assert_eq!(entry(&conn, "setting", "theme_x"), None);
    // A manual delete leaves a tombstone entry (never pushed: a setting is never deleted).
    conn.execute("DELETE FROM synced_settings WHERE key = 'theme_x'", [])
        .expect("delete");
    assert!(entry(&conn, "setting", "theme_x").is_some_and(|e| e.2));
}

/// Migration 0016 (V2.7): the four V2 tables are tracked on their synced columns only.
#[test]
fn v2_tables_are_tracked_on_their_synced_columns() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Alpha");
    let t = task(&conn, "Write", Some(&s), None);
    let u = task(&conn, "Read", Some(&s), None);
    let at = "2026-10-10T10:00:00.000Z";
    conn.execute_batch(&format!(
        "INSERT INTO board_columns (id, subject_id, name, position, is_done, created_at, \
           updated_at) VALUES ('col', '{s}', 'Chez le client', 5, 0, '{at}', '{at}');
         INSERT INTO time_segments (id, task_id, source, started_at, ended_at, \
           created_at, updated_at) VALUES ('seg', '{t}', 'manual', '{at}', '{at}', '{at}', '{at}');
         INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
           updated_at) VALUES ('rel', '{t}', '{u}', 'blocks', '{at}', '{at}');
         INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
           created_at, updated_at) VALUES ('att', '{t}', 'a.pdf', '/tmp/a.pdf', \
           'application/pdf', 3, '{at}', '{at}');"
    ))
    .expect("insert v2 rows");
    for (entity, id) in [
        ("board_column", "col"),
        ("time_segment", "seg"),
        ("relation", "rel"),
        ("attachment", "att"),
    ] {
        assert!(
            entry(&conn, entity, id).is_some_and(|e| !e.2),
            "{entity} insert queued"
        );
    }

    // Synced columns: each update is queued again.
    for (sql, entity, id) in [
        (
            "UPDATE board_columns SET name = 'Envoyé' WHERE id = 'col'",
            "board_column",
            "col",
        ),
        (
            "UPDATE board_columns SET is_done = 1 WHERE id = 'col'",
            "board_column",
            "col",
        ),
        (
            "UPDATE time_segments SET note = 'appel' WHERE id = 'seg'",
            "time_segment",
            "seg",
        ),
        (
            "UPDATE time_segments SET stop_reason = 'waiting' WHERE id = 'seg'",
            "time_segment",
            "seg",
        ),
        (
            "UPDATE task_relations SET kind = 'relates_to' WHERE id = 'rel'",
            "relation",
            "rel",
        ),
        (
            "UPDATE attachments SET file_name = 'b.pdf' WHERE id = 'att'",
            "attachment",
            "att",
        ),
        (
            "UPDATE attachments SET deleted_at = 'x' WHERE id = 'att'",
            "attachment",
            "att",
        ),
    ] {
        let before = entry(&conn, entity, id).expect("queued").0;
        conn.execute(sql, []).expect(sql);
        assert!(
            entry(&conn, entity, id).expect("queued").0 > before,
            "{sql}"
        );
    }
    let before = entry(&conn, "subject", &s).expect("subject").0;
    conn.execute("UPDATE subjects SET is_group = 1 WHERE id = ?1", [&s])
        .expect("group");
    assert!(entry(&conn, "subject", &s).expect("subject").0 > before);
    let before = entry(&conn, "task", &t).expect("task").0;
    conn.execute(
        "UPDATE tasks SET board_column_id = 'col' WHERE id = ?1",
        [&t],
    )
    .expect("column");
    assert!(entry(&conn, "task", &t).expect("task").0 > before);

    // Local-only columns and `updated_at`: nothing.
    test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
    let before = seq(&conn);
    conn.execute_batch(
        "UPDATE time_segments SET agent_session_id = 'sess', updated_at = 'y' WHERE id = 'seg';
         UPDATE attachments SET stored_path = '/elsewhere/b.pdf', updated_at = 'y' \
           WHERE id = 'att';
         UPDATE board_columns SET updated_at = 'y' WHERE id = 'col';
         UPDATE task_relations SET updated_at = 'y' WHERE id = 'rel';",
    )
    .expect("local-only writes");
    assert_eq!(seq(&conn), before);

    // Hard deletes leave tombstones; a purged task takes its rows with it.
    conn.execute("DELETE FROM board_columns WHERE id = 'col'", [])
        .expect("delete column");
    assert!(entry(&conn, "board_column", "col").is_some_and(|e| e.2));
    conn.execute("DELETE FROM tasks WHERE id = ?1", [&t])
        .expect("purge task");
    for (entity, id) in [
        ("time_segment", "seg"),
        ("relation", "rel"),
        ("attachment", "att"),
    ] {
        assert!(
            entry(&conn, entity, id).is_some_and(|e| e.2),
            "{entity} tombstone"
        );
    }
}

/// Migration 0016 on a database at schema 0015: the outbox keeps its rows and accepts the
/// four new entities.
#[test]
fn migration_0016_keeps_the_outbox() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("v15.sqlite3");
    {
        let mut conn = Connection::open(&path).expect("open");
        MIGRATIONS
            .to_version(&mut conn, 15)
            .expect("migrate to v15");
        conn.execute(
            "INSERT INTO sync_outbox (entity, id, seq, changed_at, purged) \
             VALUES ('task', 'gone', 7, '2026-01-01T00:00:00.000Z', 1)",
            [],
        )
        .expect("seed v15");
        assert!(conn
            .execute(
                "INSERT INTO sync_outbox (entity, id, seq, changed_at) \
                 VALUES ('board_column', 'c', 1, 'x')",
                [],
            )
            .is_err());
    }
    let conn = crate::db::open(&path).expect("open and migrate");
    assert_eq!(trigger_count(&conn).expect("count"), TRIGGER_COUNT);
    assert_eq!(
        entry(&conn, "task", "gone"),
        Some((7, "2026-01-01T00:00:00.000Z".into(), true))
    );
    for entity in [
        "board_column",
        "time_segment",
        "relation",
        "attachment",
        "note_group",
        "note_page",
        "note_attachment",
    ] {
        conn.execute(
            "INSERT INTO sync_outbox (entity, id, seq, changed_at) VALUES (?1, 'x', 1, 'x')",
            [entity],
        )
        .expect(entity);
    }
}

/// Migration 0017 (V2.7 bis): `sha256` is tracked like the other synced columns of an
/// attachment; `remote` (where its file stands with the server) is local-only.
#[test]
fn an_attachments_hash_is_tracked_and_its_file_state_is_not() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "Write", None, None);
    conn.execute(
        "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
         created_at, updated_at) VALUES ('att', ?1, 'a.pdf', '/tmp/a.pdf', 'application/pdf', \
         3, 'c', 'c')",
        [&t],
    )
    .expect("insert");
    assert_eq!(
        conn.query_row(
            "SELECT remote || '|' || (sha256 IS NULL) FROM attachments",
            [],
            |r| r.get::<_, String>(0)
        )
        .expect("defaults"),
        "local|1"
    );
    let before = entry(&conn, "attachment", "att").expect("queued").0;
    conn.execute("UPDATE attachments SET sha256 = 'abc' WHERE id = 'att'", [])
        .expect("hash");
    assert!(entry(&conn, "attachment", "att").expect("queued").0 > before);
    let before = seq(&conn);
    conn.execute(
        "UPDATE attachments SET remote = 'sent' WHERE id = 'att'",
        [],
    )
    .expect("state");
    assert_eq!(seq(&conn), before, "the file state never goes out");
    assert!(conn
        .execute(
            "UPDATE attachments SET remote = 'elsewhere' WHERE id = 'att'",
            [],
        )
        .is_err());
}

/// Migration 0017 on a database at schema 0016: attachments keep their rows, start `local`
/// without a hash (the file job hashes them), and the triggers are all there.
#[test]
fn migration_0017_keeps_the_attachments() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("v16.sqlite3");
    {
        let mut conn = Connection::open(&path).expect("open");
        MIGRATIONS
            .to_version(&mut conn, 16)
            .expect("migrate to v16");
        conn.execute_batch(
            "INSERT INTO tasks (id, title, position, created_at, updated_at) \
               VALUES ('t', 'T', 1, 'c', 'c');
             INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
               created_at, updated_at) VALUES ('att', 't', 'a.pdf', '/tmp/a.pdf', \
               'application/pdf', 3, 'c', 'c');",
        )
        .expect("seed v16");
    }
    let conn = crate::db::open(&path).expect("open and migrate");
    assert_eq!(trigger_count(&conn).expect("count"), TRIGGER_COUNT);
    assert_eq!(
        conn.query_row(
            "SELECT file_name || '|' || remote || '|' || (sha256 IS NULL) FROM attachments",
            [],
            |r| r.get::<_, String>(0)
        )
        .expect("row"),
        "a.pdf|local|1"
    );
}

#[test]
fn trigger_count_matches() {
    let conn = open_in_memory().expect("db");
    assert_eq!(TRIGGER_COUNT, 30);
    assert_eq!(trigger_count(&conn).expect("count"), 30);
}

/// Migration 0021: a notebook's rows are tracked like the other synced tables, and an
/// attachment is a `note_attachment` when it belongs to a page (`task_id` NULL).
#[test]
fn notebook_rows_and_page_images_are_tracked() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "Alpha");
    let g = crate::db::notes::create_group(
        &conn,
        &crate::model::CreateNoteGroupInput {
            subject_id: s.clone(),
            name: "Décisions".into(),
        },
    )
    .expect("group");
    let p = crate::db::notes::create_page(
        &conn,
        &crate::model::CreateNotePageInput {
            subject_id: s.clone(),
            group_id: Some(g.id.clone()),
            title: "Page".into(),
            body: String::new(),
            kind: crate::model::NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page");
    assert!(entry(&conn, "note_group", &g.id).is_some_and(|e| !e.2));
    let (seq1, _, _) = entry(&conn, "note_page", &p.id).expect("page queued");
    conn.execute("UPDATE note_pages SET body = 'x' WHERE id = ?1", [&p.id])
        .expect("edit");
    assert!(entry(&conn, "note_page", &p.id).expect("queued").0 > seq1);
    // `updated_at` alone is never tracked.
    let before = seq(&conn);
    conn.execute(
        "UPDATE note_pages SET updated_at = 'z' WHERE id = ?1",
        [&p.id],
    )
    .expect("touch");
    assert_eq!(seq(&conn), before);

    conn.execute(
        "INSERT INTO attachments (id, note_page_id, file_name, stored_path, mime_type, size, \
         created_at, updated_at) VALUES ('img', ?1, 'a.png', '/tmp/a.png', 'image/png', 3, \
         'c', 'c')",
        [&p.id],
    )
    .expect("page image");
    assert!(entry(&conn, "note_attachment", "img").is_some());
    assert!(entry(&conn, "attachment", "img").is_none());
    conn.execute("DELETE FROM sync_outbox", []).expect("clear");
    conn.execute("DELETE FROM attachments WHERE id = 'img'", [])
        .expect("purge");
    assert!(entry(&conn, "note_attachment", "img").is_some_and(|e| e.2));
    // Deleting a group moves its pages out of it: a tracked change of each page.
    let before = entry(&conn, "note_page", &p.id).map(|e| e.0);
    crate::db::notes::delete_group(&conn, &g.id).expect("delete group");
    assert!(entry(&conn, "note_group", &g.id).is_some_and(|e| e.2));
    assert!(entry(&conn, "note_page", &p.id).map(|e| e.0) > before);
}
