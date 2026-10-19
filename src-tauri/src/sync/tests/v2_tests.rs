//! Protocol 3 on the Mac (V2.7 task 6): Kanban columns, time segments, relations and
//! attachment metadata are pushed, pulled, parked, tombstoned and normalised (N9, N10).

use rusqlite::params;
use sync_proto::{
    AttachmentData, BoardColumnData, Entity, RelationData, RelationKind, SegmentSource,
    TimeSegmentData,
};

use super::fake::FakeServer;
use super::*;
use crate::db::test_support::{subject, task};
use crate::db::{attachments, board_columns, subjects, workspace};

async fn linked() -> (FakeServer, Mac) {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    mac.link(&server).await;
    mac.sync().await;
    (server, mac)
}

fn versioned<T>(id: &str, at: &str, data: T) -> Versioned<T> {
    Versioned {
        id: id.into(),
        updated_at: at.into(),
        device_id: "other-device".into(),
        data: Some(data),
    }
}

fn column_change(id: &str, at: &str, subject: Option<&str>, name: &str) -> Change {
    Change::BoardColumn(versioned(
        id,
        at,
        BoardColumnData {
            subject_id: subject.map(String::from),
            name: name.into(),
            position: 1.0,
            is_done: false,
            created_at: at.into(),
        },
    ))
}

fn segment_data(task: &str, started: &str, ended: Option<&str>) -> TimeSegmentData {
    TimeSegmentData {
        task_id: task.into(),
        source: SegmentSource::Auto,
        started_at: started.into(),
        ended_at: ended.map(String::from),
        stop_reason: ended.map(|_| "waiting".to_string()),
        note: String::new(),
        created_at: started.into(),
        deleted_at: None,
    }
}

fn segment_change(id: &str, at: &str, data: TimeSegmentData) -> Change {
    Change::TimeSegment(versioned(id, at, data))
}

fn relation_change(id: &str, at: &str, from: &str, to: &str) -> Change {
    Change::Relation(versioned(
        id,
        at,
        RelationData {
            from_task_id: from.into(),
            to_task_id: to.into(),
            kind: RelationKind::Blocks,
            created_at: at.into(),
            deleted_at: None,
        },
    ))
}

fn attachment_change(id: &str, at: &str, task: &str, name: &str) -> Change {
    Change::Attachment(versioned(
        id,
        at,
        AttachmentData {
            task_id: task.into(),
            file_name: name.into(),
            mime_type: "application/pdf".into(),
            size: 1234,
            sha256: None,
            created_at: at.into(),
            deleted_at: None,
        },
    ))
}

#[tokio::test]
async fn local_v2_rows_are_pushed_without_local_only_columns() {
    let (server, mac) = linked().await;
    let (s, t, u, col) = {
        let conn = mac.conn();
        let s = subject(&conn, "P");
        let t = task(&conn, "T", Some(&s), None);
        let u = task(&conn, "U", Some(&s), None);
        let col = board_columns::ensure(&conn, Some(&s)).expect("columns")[2]
            .id
            .clone();
        board_columns::move_task(&conn, &t, &col).expect("move");
        conn.execute_batch(&format!(
            "INSERT INTO time_segments (id, task_id, source, started_at, ended_at, \
               stop_reason, created_at, updated_at) VALUES ('seg', '{t}', 'manual', \
               '2026-10-10T09:00:00.000Z', '2026-10-10T09:30:00.000Z', NULL, \
               '2026-10-10T09:30:00.000Z', '2026-10-10T09:30:00.000Z');
             INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
               updated_at) VALUES ('rel', '{t}', '{u}', 'blocks', 'c', 'c');
             INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
               created_at, updated_at) VALUES ('att', '{t}', 'devis.pdf', '/secret/devis.pdf', \
               'application/pdf', 42, 'c', 'c');"
        ))
        .expect("v2 rows");
        (s, t, u, col)
    };
    mac.sync().await;
    assert!(mac.outbox().is_empty());
    assert_eq!(col, format!("col-{s}-2"), "default columns have fixed ids");
    let Some(Change::Task(v)) = server.get(Entity::Task, &t) else {
        panic!("task pushed");
    };
    assert_eq!(v.data.expect("data").board_column_id, Some(col.clone()));
    assert!(matches!(
        server.get(Entity::BoardColumn, &col),
        Some(Change::BoardColumn(Versioned { data: Some(_), .. }))
    ));
    let Some(Change::TimeSegment(v)) = server.get(Entity::TimeSegment, "seg") else {
        panic!("segment pushed");
    };
    assert_eq!(
        v.data.expect("data").ended_at.as_deref(),
        Some("2026-10-10T09:30:00.000Z")
    );
    let Some(Change::Relation(v)) = server.get(Entity::Relation, "rel") else {
        panic!("relation pushed");
    };
    assert_eq!(v.data.expect("data").to_task_id, u);
    let Some(change @ Change::Attachment(_)) = server.get(Entity::Attachment, "att") else {
        panic!("attachment pushed");
    };
    let json = serde_json::to_string(&change).expect("json");
    assert!(
        !json.contains("secret"),
        "stored_path never travels: {json}"
    );
}

#[tokio::test]
async fn v2_rows_pulled_before_their_tasks_are_parked_then_applied() {
    let (server, mac) = linked().await;
    workspace::ensure(&mac.conn(), mac.docs.path()).expect("app folder");
    server.put(segment_change(
        "seg",
        &stamp(1),
        segment_data("t", &stamp(1), Some(&stamp(2))),
    ));
    server.put(relation_change("rel", &stamp(2), "t", "u"));
    server.put(attachment_change("att", &stamp(3), "t", "devis.pdf"));
    server.put(column_change("col", &stamp(4), Some("p"), "À valider"));
    server.put(subject_change("p", &stamp(5), None, None));
    server.put(task_change(
        "t",
        &stamp(6),
        task_data(Some("p"), None, &stamp(6)),
    ));
    let report = mac.sync().await;
    // `u` is missing: the relation waits; everything else is applied in order.
    assert_eq!(report.parked, 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM time_segments"), 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM attachments"), 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM board_columns"), 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM task_relations"), 0);
    assert_eq!(
        mac.text("SELECT entity FROM sync_parked").as_deref(),
        Some("relation")
    );
    // A pulled attachment points into this Mac's attachment folder (no file is made).
    let expected = mac
        .docs
        .path()
        .join(workspace::FOLDER_NAME)
        .join(attachments::FOLDER_NAME)
        .join(subjects::folder_name("Projet p"))
        .join("Tâche (t)")
        .join("devis.pdf");
    assert_eq!(
        mac.text("SELECT stored_path FROM attachments"),
        Some(expected.to_string_lossy().into_owned())
    );
    assert!(!expected.exists());
    server.put(task_change(
        "u",
        &stamp(8),
        task_data(Some("p"), None, &stamp(8)),
    ));
    let report = mac.sync().await;
    assert_eq!(report.parked, 0);
    assert_eq!(mac.count("SELECT COUNT(*) FROM task_relations"), 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn pulled_attachments_keep_their_local_path_and_segments_their_session() {
    let (server, mac) = linked().await;
    let t = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        crate::db::test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
        conn.execute_batch(&format!(
            "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
               created_at, updated_at) VALUES ('att', '{t}', 'a.pdf', '/mine/a.pdf', \
               'application/pdf', 1, 'c', 'c');
             INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
               ended_at, created_at, updated_at) VALUES ('seg', '{t}', 'sess', 'auto', \
               '{a}', '{a}', '{a}', '{a}');",
            a = stamp(1)
        ))
        .expect("rows");
        t
    };
    mac.sync().await;
    server.put(attachment_change(
        "att",
        "2030-01-01T00:00:00.000Z",
        &t,
        "b.pdf",
    ));
    let mut data = segment_data(&t, &stamp(1), Some(&stamp(5)));
    data.note = "appel".into();
    server.put(segment_change("seg", "2030-01-01T00:00:00.000Z", data));
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT file_name || '|' || stored_path FROM attachments")
            .as_deref(),
        Some("b.pdf|/mine/a.pdf")
    );
    assert_eq!(
        mac.text("SELECT note || '|' || agent_session_id FROM time_segments")
            .as_deref(),
        Some("appel|sess")
    );
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn a_task_waits_for_its_column_and_a_column_for_its_project() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    let mut data = task_data(Some("p"), None, &stamp(2));
    data.board_column_id = Some("col".into());
    server.put(task_change("t", &stamp(2), data));
    server.put(column_change("orphan", &stamp(3), Some("gone"), "X"));
    let report = mac.sync().await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 't' AND board_column_id IS NULL"),
        1
    );
    assert_eq!(report.parked, 1, "the column without project");
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 2);
    server.put(column_change("col", &stamp(4), Some("p"), "À valider"));
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT board_column_id FROM tasks WHERE id = 't'")
            .as_deref(),
        Some("col")
    );
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 1);
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn a_task_tombstone_takes_its_segments_relations_and_attachments() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(task_change(
        "t",
        &stamp(2),
        task_data(Some("p"), None, &stamp(2)),
    ));
    server.put(task_change(
        "u",
        &stamp(3),
        task_data(Some("p"), None, &stamp(3)),
    ));
    server.put(task_change(
        "child",
        &stamp(4),
        task_data(Some("p"), Some("t"), &stamp(4)),
    ));
    server.put(segment_change(
        "seg",
        &stamp(5),
        segment_data("t", &stamp(5), Some(&stamp(6))),
    ));
    server.put(segment_change(
        "child-seg",
        &stamp(6),
        segment_data("child", &stamp(6), Some(&stamp(7))),
    ));
    server.put(relation_change("rel", &stamp(7), "u", "t"));
    server.put(attachment_change("att", &stamp(8), "t", "a.pdf"));
    mac.sync().await;
    assert_eq!(mac.count("SELECT COUNT(*) FROM time_segments"), 2);
    // Another device purged `t`; the server also holds the tombstone of its segment.
    server.put(tombstone(Entity::TimeSegment, "seg", &stamp(9)));
    server.put(tombstone(Entity::Task, "t", &stamp(10)));
    mac.sync().await;
    for table in ["time_segments", "task_relations", "attachments"] {
        assert_eq!(
            mac.count(&format!("SELECT COUNT(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks"), 1);
    mac.sync().await;
    // The rows the server did not tombstone were deleted as local changes and pushed.
    for (entity, id) in [
        (Entity::Task, "child"),
        (Entity::TimeSegment, "child-seg"),
        (Entity::Relation, "rel"),
        (Entity::Attachment, "att"),
    ] {
        assert!(
            server.get(entity, id).is_some_and(|c| c.is_tombstone()),
            "{id} tombstoned"
        );
    }
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn a_project_tombstone_takes_its_columns() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    mac.sync().await;
    let col = {
        let conn = mac.conn();
        board_columns::ensure(&conn, Some("p")).expect("columns")[0]
            .id
            .clone()
    };
    mac.sync().await;
    server.put(tombstone(Entity::Subject, "p", &stamp(2)));
    mac.sync().await;
    assert_eq!(mac.count("SELECT COUNT(*) FROM board_columns"), 0);
    mac.sync().await;
    assert!(server
        .get(Entity::BoardColumn, &col)
        .is_some_and(|c| c.is_tombstone()));
}

#[tokio::test]
async fn a_pulled_open_segment_runs_beside_the_local_one() {
    let (server, mac) = linked().await;
    let t = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        crate::db::test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
        conn.execute(
            "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
             created_at, updated_at) VALUES ('mine', ?1, 'sess', 'auto', ?2, ?2, ?2)",
            params![t, stamp(1)],
        )
        .expect("open segment");
        t
    };
    mac.sync().await;
    server.put(segment_change(
        "theirs",
        &stamp(20),
        segment_data(&t, &stamp(10), None),
    ));
    let report = mac.sync().await;
    assert_eq!(report.applied, 1);
    assert_eq!(report.corrected, 0);
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM time_segments WHERE ended_at IS NULL"),
        2,
        "both Macs at work"
    );
    assert!(mac.outbox().is_empty(), "nothing closed, nothing to push");
    let Some(Change::TimeSegment(v)) = server.get(Entity::TimeSegment, "mine") else {
        panic!("pushed");
    };
    assert_eq!(v.data.expect("data").ended_at, None);
}

#[tokio::test]
async fn relations_created_twice_keep_one() {
    let (server, mac) = linked().await;
    let (t, u) = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        let u = task(&conn, "U", None, None);
        conn.execute(
            "INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
             updated_at) VALUES ('rel-b', ?1, ?2, 'blocks', 'c', 'c')",
            params![t, u],
        )
        .expect("relation");
        (t, u)
    };
    mac.sync().await;
    // Another device made the same relation; the lowest id is kept everywhere.
    server.put(relation_change("rel-a", &stamp(5), &t, &u));
    mac.sync().await;
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT id FROM task_relations WHERE deleted_at IS NULL")
            .as_deref(),
        Some("rel-a")
    );
    let Some(Change::Relation(v)) = server.get(Entity::Relation, "rel-b") else {
        panic!("pushed");
    };
    assert!(v.data.expect("data").deleted_at.is_some());
    // The reverse: the pulled duplicate has the higher id, it is soft-deleted here.
    server.put(relation_change("rel-z", &stamp(6), &t, &u));
    mac.sync().await;
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT id FROM task_relations WHERE deleted_at IS NULL")
            .as_deref(),
        Some("rel-a")
    );
    let Some(Change::Relation(v)) = server.get(Entity::Relation, "rel-z") else {
        panic!("stored");
    };
    assert!(v.data.expect("data").deleted_at.is_some());
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn reversed_relations_created_twice_keep_one() {
    let (server, mac) = linked().await;
    let (t, u) = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        let u = task(&conn, "U", None, None);
        conn.execute(
            "INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
             updated_at) VALUES ('rel-b', ?1, ?2, 'blocks', 'c', 'c'), \
             ('rel-m', ?1, ?2, 'relates_to', 'c', 'c')",
            params![t, u],
        )
        .expect("relations");
        (t, u)
    };
    mac.sync().await;
    let live = |mac: &Mac| {
        let conn = mac.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, from_task_id, kind FROM task_relations \
                 WHERE deleted_at IS NULL ORDER BY id",
            )
            .expect("prepare");
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("query");
        rows.collect::<Result<Vec<(String, String, String)>, _>>()
            .expect("rows")
    };
    let pushed_deleted = |id: &str| {
        let Some(Change::Relation(v)) = server.get(Entity::Relation, id) else {
            panic!("{id} on the server");
        };
        v.data.expect("data").deleted_at.is_some()
    };
    // Another device: U blocks T (lower id) and U relates to T (higher id). A blocks B with
    // B blocks A is one relation too many, and « Liée à » is symmetric.
    server.put(relation_change("rel-a", &stamp(5), &u, &t));
    let mut related = relation_change("rel-z", &stamp(6), &u, &t);
    if let Change::Relation(v) = &mut related {
        if let Some(d) = v.data.as_mut() {
            d.kind = RelationKind::RelatesTo;
        }
    }
    server.put(related);
    mac.sync().await;
    mac.sync().await;
    assert_eq!(
        live(&mac),
        vec![
            ("rel-a".to_string(), u.clone(), "blocks".to_string()),
            ("rel-m".to_string(), t.clone(), "relates_to".to_string()),
        ]
    );
    assert!(pushed_deleted("rel-b"), "the local reversed twin goes");
    assert!(pushed_deleted("rel-z"), "the pulled reversed twin goes");
    assert!(!pushed_deleted("rel-a"));
    assert!(!pushed_deleted("rel-m"));
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn n9_a_task_in_another_projects_column_leaves_it() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(subject_change("q", &stamp(2), None, None));
    server.put(column_change("col-q", &stamp(3), Some("q"), "À valider"));
    let mut data = task_data(Some("p"), None, &stamp(4));
    data.board_column_id = Some("col-q".into());
    server.put(task_change("t", &stamp(4), data));
    let report = mac.sync().await;
    assert_eq!(report.corrected, 1);
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 't' AND board_column_id IS NULL"),
        1
    );
    mac.sync().await;
    let Some(Change::Task(v)) = server.get(Entity::Task, "t") else {
        panic!("pushed");
    };
    assert_eq!(v.data.expect("data").board_column_id, None);
}

#[test]
fn n10_two_open_segments_on_a_task_close_the_older() {
    let conn = crate::db::open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    crate::db::test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
    // Only reachable without the local index (a safety net).
    conn.execute("DROP INDEX idx_segments_open", [])
        .expect("drop index");
    for (id, at) in [("old", stamp(1)), ("new", stamp(5))] {
        conn.execute(
            "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
             created_at, updated_at) VALUES (?1, ?2, 'sess', 'auto', ?3, ?3, ?3)",
            params![id, t, at],
        )
        .expect("segment");
    }
    // A running segment pulled from another Mac (no session here) is never touched.
    conn.execute(
        "INSERT INTO time_segments (id, task_id, source, started_at, created_at, \
         updated_at) VALUES ('theirs', ?1, 'auto', ?2, ?2, ?2)",
        params![t, stamp(9)],
    )
    .expect("pulled segment");
    conn.execute("DELETE FROM sync_outbox", []).expect("clear");
    assert_eq!(
        crate::sync::normalize::normalize(&conn).expect("normalize"),
        1
    );
    let closed: String = conn
        .query_row(
            "SELECT ended_at || '|' || stop_reason FROM time_segments WHERE id = 'old'",
            [],
            |r| r.get(0),
        )
        .expect("old");
    assert_eq!(closed, format!("{}|app_closed", stamp(5)));
    let queued: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE entity = 'time_segment' AND id = 'old'",
            [],
            |r| r.get(0),
        )
        .expect("queued");
    assert_eq!(queued, 1);
    assert_eq!(crate::sync::normalize::normalize(&conn).expect("again"), 0);
    let theirs: Option<String> = conn
        .query_row(
            "SELECT ended_at FROM time_segments WHERE id = 'theirs'",
            [],
            |r| r.get(0),
        )
        .expect("theirs");
    assert_eq!(theirs, None);
}

#[tokio::test]
async fn a_pulled_attachment_without_task_folder_gets_an_absolute_path() {
    // No app folder recorded yet: the placeholder is still absolute.
    let (server, mac) = linked().await;
    server.put(task_change(
        "t",
        &stamp(1),
        task_data(None, None, &stamp(1)),
    ));
    server.put(attachment_change("att", &stamp(2), "t", "devis.pdf"));
    mac.sync().await;
    let stored = mac
        .text("SELECT stored_path FROM attachments WHERE id = 'att'")
        .expect("path");
    let path = std::path::Path::new(&stored);
    assert!(path.is_absolute(), "{stored}");
    assert!(path.ends_with(
        std::path::Path::new(attachments::FOLDER_NAME)
            .join("t")
            .join("devis.pdf")
    ));
    // A pulled attachment of a deleted task: under the app folder, by task id.
    workspace::ensure(&mac.conn(), mac.docs.path()).expect("app folder");
    let mut gone = task_data(None, None, &stamp(3));
    gone.deleted_at = Some(stamp(3));
    server.put(task_change("gone", &stamp(3), gone));
    server.put(attachment_change("att-2", &stamp(4), "gone", "a.png"));
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT stored_path FROM attachments WHERE id = 'att-2'"),
        Some(
            mac.docs
                .path()
                .join(workspace::FOLDER_NAME)
                .join(attachments::FOLDER_NAME)
                .join("gone")
                .join("a.png")
                .to_string_lossy()
                .into_owned()
        )
    );
}

#[test]
fn default_columns_are_queued_at_the_epoch_stamp() {
    let conn = crate::db::open_in_memory().expect("db");
    let s = subject(&conn, "P");
    board_columns::ensure(&conn, Some(&s)).expect("columns");
    let stamps: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT changed_at FROM sync_outbox WHERE entity = 'board_column'")
            .expect("prepare");
        let rows = stmt.query_map([], |r| r.get(0)).expect("query");
        rows.collect::<Result<_, _>>().expect("rows")
    };
    assert_eq!(stamps, vec![sync_proto::EPOCH_STAMP.to_string(); 4]);
    // A real edit afterwards gets a real stamp.
    let id = board_columns::default_id(Some(&s), 2);
    board_columns::rename(&conn, &id, "Chez le client").expect("rename");
    let stamp: String = conn
        .query_row(
            "SELECT changed_at FROM sync_outbox WHERE entity = 'board_column' AND id = ?1",
            [&id],
            |r| r.get(0),
        )
        .expect("stamp");
    assert!(stamp.as_str() > sync_proto::EPOCH_STAMP);
}

#[test]
fn default_columns_have_fixed_ids() {
    let conn = crate::db::open_in_memory().expect("db");
    let s = subject(&conn, "P");
    let ids: Vec<String> = board_columns::ensure(&conn, Some(&s))
        .expect("columns")
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(
        ids,
        (0..4).map(|i| format!("col-{s}-{i}")).collect::<Vec<_>>()
    );
    let inbox: Vec<String> = board_columns::ensure(&conn, None)
        .expect("inbox")
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(
        inbox,
        ["col-inbox-0", "col-inbox-1", "col-inbox-2", "col-inbox-3"]
    );
}

const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/// V2.7 bis: the hash travels with the attachment's metadata. A pulled hash is stored (the
/// whole-row "last writer wins" would otherwise erase another device's hash), a version
/// without one keeps the local hash, and the hash goes back out with the next local change.
#[tokio::test]
async fn a_pulled_hash_is_kept_and_sent_back() {
    let (server, mac) = linked().await;
    workspace::ensure(&mac.conn(), mac.docs.path()).expect("app folder");
    let t = task(&mac.conn(), "T", None, None);
    mac.sync().await;
    let mut change = attachment_change("att", &stamp(2), &t, "a.pdf");
    if let Change::Attachment(Versioned { data: Some(d), .. }) = &mut change {
        d.sha256 = Some(HASH.into());
    }
    server.put(change);
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT sha256 || '|' || remote FROM attachments WHERE id = 'att'")
            .as_deref(),
        Some(format!("{HASH}|missing").as_str()),
        "pulled with its hash; its file is elsewhere"
    );

    server.put(attachment_change("att", &stamp(3), &t, "b.pdf"));
    mac.sync().await;
    assert_eq!(
        mac.text("SELECT file_name || '|' || sha256 FROM attachments WHERE id = 'att'")
            .as_deref(),
        Some(format!("b.pdf|{HASH}").as_str()),
        "a version without hash keeps the local one"
    );

    attachments::delete(&mac.conn(), "att").expect("delete");
    mac.sync().await;
    let Some(Change::Attachment(v)) = server.get(Entity::Attachment, "att") else {
        panic!("attachment pushed");
    };
    let data = v.data.expect("soft delete");
    assert!(data.deleted_at.is_some());
    assert_eq!(
        data.sha256.as_deref(),
        Some(HASH),
        "sent back with the deletion"
    );
}

/// V2.7 bis: an attachment made before has no hash; the file job's first pass hashes its file
/// and the next sync sends it (its file is sent after that). One whose file is not here
/// becomes `missing`.
#[tokio::test]
async fn an_older_attachment_gets_its_hash_from_the_file_job() {
    let (server, mac) = linked().await;
    let file = mac.docs.path().join("ancien.pdf");
    std::fs::write(&file, b"%PDF ancien").expect("file");
    let t = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        conn.execute(
            "INSERT INTO attachments (id, task_id, file_name, stored_path, mime_type, size, \
             created_at, updated_at) VALUES ('att', ?1, 'ancien.pdf', ?2, 'application/pdf', \
             3, 'c', 'c'), ('gone', ?1, 'perdu.pdf', ?3, 'application/pdf', 3, 'c', 'c')",
            params![
                t,
                file.to_string_lossy(),
                mac.docs.path().join("perdu.pdf").to_string_lossy()
            ],
        )
        .expect("older attachments");
        t
    };
    mac.sync().await;
    let Some(Change::Attachment(v)) = server.get(Entity::Attachment, "att") else {
        panic!("attachment pushed");
    };
    assert_eq!(v.data.expect("data").sha256, None);

    let report = crate::sync::files::run(
        &mac.db,
        &mac.client,
        &QuietEvents,
        crate::sync::files::FileOptions::default(),
    )
    .await;
    assert_eq!(report.hashed, 1);
    assert_eq!(report.uploaded, 0, "the hash goes out first");
    let expected = attachments::sha256_bytes(b"%PDF ancien");
    assert_eq!(
        mac.text("SELECT sha256 || '|' || size FROM attachments WHERE id = 'att'")
            .as_deref(),
        Some(format!("{expected}|11").as_str()),
        "hash and real size"
    );
    assert!(mac.outbox_has("attachment", "att"));
    assert_eq!(
        mac.text("SELECT remote FROM attachments WHERE id = 'gone'")
            .as_deref(),
        Some("missing")
    );
    mac.sync().await;
    let Some(Change::Attachment(v)) = server.get(Entity::Attachment, "att") else {
        panic!("attachment pushed");
    };
    let data = v.data.expect("data");
    assert_eq!(data.sha256.as_deref(), Some(expected.as_str()));
    assert_eq!(data.size, 11);
    assert_eq!(data.task_id, t);
}

/// « Arrêter » on another device (docs/SYNC.md § 0.8): the pulled stop of this Mac's running
/// segment is accepted (no reason, its session kept), and Claude's next turn opens a new one.
#[tokio::test]
async fn a_pulled_manual_stop_of_the_local_segment_is_accepted() {
    let (server, mac) = linked().await;
    let t = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        crate::db::test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
        crate::db::test_support::set_session_state(&conn, "sess", "working", None, &stamp(1));
        crate::db::time_segments::reconcile(&conn, &t, &stamp(1)).expect("reconcile");
        t
    };
    mac.sync().await;
    let mine = mac
        .text("SELECT id FROM time_segments WHERE ended_at IS NULL")
        .expect("running");
    let mut data = segment_data(&t, &stamp(1), Some(&stamp(5)));
    data.stop_reason = None;
    server.put(segment_change(&mine, &stamp(20), data));
    let report = mac.sync().await;
    assert_eq!(report.applied, 1);
    assert_eq!(
        mac.text(
            "SELECT ended_at || '|' || COALESCE(stop_reason, '-') || '|' || agent_session_id \
             FROM time_segments"
        )
        .as_deref(),
        Some(format!("{}|-|sess", stamp(5)).as_str())
    );
    assert!(mac.outbox().is_empty(), "the pulled stop is not sent back");
    // Claude still at work: the next session change opens a new segment beside it.
    {
        let conn = mac.conn();
        crate::db::test_support::set_session_state(&conn, "sess", "working", None, &stamp(21));
        crate::db::time_segments::reconcile(&conn, &t, &stamp(21)).expect("reconcile");
    }
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM time_segments WHERE ended_at IS NULL"),
        1
    );
    assert!(
        mac.text("SELECT id FROM time_segments WHERE ended_at IS NULL")
            .is_some_and(|id| id != mine),
        "a new segment, never the stopped one"
    );
}

/// A pulled version that runs again a segment this Mac stopped (its chrono moved on to a new
/// one) never violates `idx_segments_open`: that row stops being this Mac's.
#[tokio::test]
async fn a_pulled_running_version_of_a_stopped_local_segment_keeps_the_index() {
    let (server, mac) = linked().await;
    let t = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        crate::db::test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
        conn.execute_batch(&format!(
            "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
               ended_at, created_at, updated_at) VALUES ('old', '{t}', 'sess', 'auto', \
               '{a}', '{b}', '{a}', '{b}');
             INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
               created_at, updated_at) VALUES ('new', '{t}', 'sess', 'auto', '{c}', '{c}', \
               '{c}');",
            a = stamp(1),
            b = stamp(2),
            c = stamp(3)
        ))
        .expect("segments");
        t
    };
    mac.sync().await;
    server.put(segment_change(
        "old",
        &stamp(20),
        segment_data(&t, &stamp(1), None),
    ));
    let report = mac.sync().await;
    assert_eq!(report.applied, 1);
    assert_eq!(
        mac.text(
            "SELECT COALESCE(ended_at, 'running') || '|' || COALESCE(agent_session_id, '-') \
             FROM time_segments WHERE id = 'old'"
        )
        .as_deref(),
        Some("running|-")
    );
    assert_eq!(
        mac.text(
            "SELECT agent_session_id FROM time_segments WHERE id = 'new' AND ended_at IS NULL"
        )
        .as_deref(),
        Some("sess")
    );
}

/// Without a newer local segment, a pulled running version of a segment stopped here stays
/// this Mac's: its chrono closes it as usual.
#[tokio::test]
async fn a_pulled_running_version_stays_local_without_a_newer_segment() {
    let (server, mac) = linked().await;
    let t = {
        let conn = mac.conn();
        let t = task(&conn, "T", None, None);
        crate::db::test_support::claude_terminal(&conn, &t, "term", "sess", "claude");
        conn.execute_batch(&format!(
            "INSERT INTO time_segments (id, task_id, agent_session_id, source, started_at, \
               ended_at, created_at, updated_at) VALUES ('old', '{t}', 'sess', 'auto', \
               '{a}', '{b}', '{a}', '{b}');",
            a = stamp(1),
            b = stamp(2)
        ))
        .expect("segment");
        t
    };
    mac.sync().await;
    server.put(segment_change(
        "old",
        &stamp(20),
        segment_data(&t, &stamp(1), None),
    ));
    let report = mac.sync().await;
    assert_eq!(report.applied, 1);
    assert_eq!(
        mac.text(
            "SELECT COALESCE(ended_at, 'running') || '|' || COALESCE(agent_session_id, '-') \
             FROM time_segments WHERE id = 'old'"
        )
        .as_deref(),
        Some("running|sess")
    );
}
