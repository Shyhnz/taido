//! Applying pulled rows (docs/SYNC.md § 2.5): order and retry, parking, UPSERT, tombstones,
//! normalisation N1–N8, terminals to close.

use sync_proto::Entity;

use super::fake::FakeServer;
use super::*;
use crate::db::test_support::{claude_terminal, section, subject, task};
use crate::db::{subjects, tasks};

/// A linked Mac with an empty outbox, against a fresh fake server.
async fn linked() -> (FakeServer, Mac) {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    mac.link(&server).await;
    mac.sync().await;
    (server, mac)
}

#[tokio::test]
async fn rows_are_applied_parents_first_with_retries_in_a_group() {
    let (server, mac) = linked().await;
    // Pulled children before their parents, all in one response.
    server.put(task_change(
        "c",
        &stamp(1),
        task_data(Some("p"), Some("a"), &stamp(1)),
    ));
    server.put(task_change(
        "a",
        &stamp(2),
        task_data(Some("p"), Some("b"), &stamp(2)),
    ));
    server.put(task_change(
        "b",
        &stamp(3),
        task_data(Some("p"), Some("top"), &stamp(3)),
    ));
    server.put(task_change(
        "top",
        &stamp(4),
        task_data(Some("p"), None, &stamp(4)),
    ));
    server.put(section_change("sec", &stamp(5), "sub"));
    server.put(subject_change("sub", &stamp(6), Some("p"), None));
    server.put(subject_change("p", &stamp(7), None, None));
    let report = mac.sync().await;
    assert_eq!(report.applied, 7);
    assert_eq!(report.parked, 0);
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks"), 4);
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
    // Two levels of child tasks are flattened (N4), and the correction is queued.
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE parent_id = 'top'"),
        3
    );
    assert!(mac.outbox_has("task", "c"));
    assert!(mac.outbox_has("task", "a"));
    assert!(!mac.outbox_has("task", "b"));
}

#[tokio::test]
async fn a_child_pulled_before_its_parent_is_parked_then_applied() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(task_change(
        "child",
        &stamp(2),
        task_data(Some("p"), Some("parent"), &stamp(2)),
    ));
    let report = mac.sync().await;
    assert_eq!(report.parked, 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks"), 0);
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 1);
    // The parent arrives in a later response: the parked child goes in with it.
    server.put(task_change(
        "parent",
        &stamp(3),
        task_data(Some("p"), None, &stamp(3)),
    ));
    let report = mac.sync().await;
    assert_eq!(report.parked, 0);
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 'child' AND parent_id = 'parent'"),
        1
    );
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn a_tombstone_drops_a_parked_row_and_a_missing_section_is_cleared() {
    let (server, mac) = linked().await;
    server.put(subject_change("p", &stamp(1), None, None));
    let mut data = task_data(Some("p"), None, &stamp(2));
    data.section_id = Some("unknown-section".into());
    server.put(task_change("t", &stamp(2), data));
    server.put(task_change(
        "orphan",
        &stamp(3),
        task_data(Some("gone"), None, &stamp(3)),
    ));
    mac.sync().await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 't' AND section_id IS NULL"),
        1
    );
    // The orphan waits for its project, `t` for its section.
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 2);
    server.put(tombstone(Entity::Task, "orphan", &stamp(4)));
    let report = mac.sync().await;
    assert_eq!(report.applied, 0, "the waiting task is not written again");
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM sync_parked WHERE id = 't'"),
        1
    );
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 1);
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn a_task_pulled_a_page_before_its_section_gets_it_back() {
    let (server, mac) = linked().await;
    server.state().page_size = 2;
    server.put(subject_change("p", &stamp(1), None, None));
    let mut data = task_data(Some("p"), None, &stamp(2));
    data.section_id = Some("sec".into());
    server.put(task_change("t", &stamp(2), data));
    // Renamed after the task was moved into it: a higher rev, the next page.
    server.put(section_change("sec", &stamp(3), "p"));
    mac.sync().await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 't' AND section_id = 'sec'"),
        1
    );
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
    assert!(mac.outbox().is_empty());
    // A later local edit keeps the section everywhere.
    mac.conn()
        .execute("UPDATE tasks SET title = 'Édité' WHERE id = 't'", [])
        .expect("edit");
    mac.sync().await;
    assert!(server.get(Entity::Task, "t").is_some_and(|c| match c {
        Change::Task(v) => v
            .data
            .is_some_and(|d| d.section_id.as_deref() == Some("sec")),
        _ => false,
    }));
}

#[tokio::test]
async fn a_parked_row_is_dropped_when_the_row_was_edited_or_deleted_locally() {
    let (server, mac) = linked().await;
    server.put(subject_change("a", &stamp(1), None, None));
    server.put(task_change(
        "t",
        &stamp(1),
        task_data(Some("a"), None, &stamp(1)),
    ));
    server.put(task_change(
        "u",
        &stamp(1),
        task_data(Some("a"), None, &stamp(1)),
    ));
    mac.sync().await;
    // Newer server versions move both tasks to project b, not here yet: parked.
    server.put(task_change(
        "t",
        &stamp(2),
        task_data(Some("b"), None, &stamp(2)),
    ));
    server.put(task_change(
        "u",
        &stamp(2),
        task_data(Some("b"), None, &stamp(2)),
    ));
    let report = mac.sync().await;
    assert_eq!(report.parked, 2);
    {
        let conn = mac.conn();
        conn.execute(
            "UPDATE tasks SET description = 'note du Mac' WHERE id = 't'",
            [],
        )
        .expect("edit");
        conn.execute("DELETE FROM tasks WHERE id = 'u'", [])
            .expect("delete");
    }
    server.put(subject_change("b", &stamp(3), None, None));
    mac.sync().await;
    assert_eq!(
        mac.count(
            "SELECT COUNT(*) FROM tasks WHERE id = 't' AND subject_id = 'a' \
             AND description = 'note du Mac'"
        ),
        1
    );
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks WHERE id = 'u'"), 0);
    assert_eq!(mac.count("SELECT COUNT(*) FROM sync_parked"), 0);
    assert!(server
        .get(Entity::Task, "u")
        .is_some_and(|c| c.is_tombstone()));
    assert!(server.get(Entity::Task, "t").is_some_and(|c| match c {
        Change::Task(v) => v.data.is_some_and(|d| d.description == "note du Mac"),
        _ => false,
    }));
}

#[tokio::test]
async fn a_new_version_of_a_parent_keeps_its_children_terminals_and_journal() {
    let (server, mac) = linked().await;
    let (s, parent, child) = {
        let conn = mac.conn();
        let s = subject(&conn, "Alpha");
        let parent = task(&conn, "Parent", Some(&s), None);
        let child = tasks::create_child(&conn, &parent, "Child").expect("child");
        claude_terminal(&conn, &parent, "term", "sess", "claude-1");
        (s, parent, child)
    };
    mac.sync().await;
    let journal = mac.count(&format!(
        "SELECT COUNT(*) FROM journal_entries WHERE task_id = '{parent}'"
    ));
    assert!(journal > 0);
    let later = "2099-01-01T00:00:00.000Z";
    let mut data = task_data(Some(&s), None, later);
    data.title = "Parent renamed".into();
    server.put(task_change(&parent, later, data));
    server.put(subject_change(&s, later, None, None));
    mac.sync().await;
    assert_eq!(
        mac.text(&format!("SELECT title FROM tasks WHERE id = '{parent}'"))
            .as_deref(),
        Some("Parent renamed")
    );
    assert_eq!(
        mac.count(&format!("SELECT COUNT(*) FROM tasks WHERE id = '{child}'")),
        1
    );
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM terminals WHERE id = 'term'"),
        1
    );
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM agent_sessions WHERE id = 'sess'"),
        1
    );
    assert_eq!(
        mac.count(&format!(
            "SELECT COUNT(*) FROM journal_entries WHERE task_id = '{parent}'"
        )),
        journal
    );
}

#[tokio::test]
async fn a_project_tombstone_queues_tombstones_for_tasks_added_offline() {
    let (server, mac) = linked().await;
    let s = subject(&mac.conn(), "Alpha");
    mac.sync().await;
    // Deleted for good on the other device, while the Mac added tasks offline.
    server.put(tombstone(Entity::Subject, &s, &stamp(999)));
    let (t, child) = {
        let conn = mac.conn();
        let t = task(&conn, "Offline", Some(&s), None);
        (
            t.clone(),
            tasks::create_child(&conn, &t, "Offline child").expect("child"),
        )
    };
    mac.sync().await;
    assert_eq!(mac.count("SELECT COUNT(*) FROM subjects"), 0);
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks"), 0);
    let outbox = mac.outbox();
    assert!(outbox
        .iter()
        .any(|(e, i, _, purged)| e == "task" && *i == t && *purged));
    assert!(outbox
        .iter()
        .any(|(e, i, _, purged)| e == "task" && *i == child && *purged));
    assert!(
        !mac.outbox_has("subject", &s),
        "the project's own tombstone is applied"
    );
    mac.sync().await;
    assert!(server
        .get(Entity::Task, &t)
        .is_some_and(|c| c.is_tombstone()));
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn terminals_of_deleted_or_completed_tasks_and_their_descendants_are_closed() {
    let (server, mac) = linked().await;
    let (s, done, done_child, gone, in_project) = {
        let conn = mac.conn();
        let s = subject(&conn, "Alpha");
        let done = task(&conn, "Done", None, None);
        let done_child = tasks::create_child(&conn, &done, "Child").expect("child");
        let gone = task(&conn, "Gone", None, None);
        let in_project = task(&conn, "In project", Some(&s), None);
        (s, done, done_child, gone, in_project)
    };
    mac.sync().await;
    let later = "2099-01-01T00:00:00.000Z";
    let mut data = task_data(None, None, later);
    data.completed_at = Some(later.into());
    server.put(task_change(&done, later, data));
    server.put(tombstone(Entity::Task, &gone, later));
    server.put(subject_change(&s, later, None, Some(later)));
    let report = mac.sync().await;
    let mut closed = report.closed_task_ids.clone();
    closed.sort();
    let mut expected = vec![done, done_child, gone, in_project];
    expected.sort();
    assert_eq!(closed, expected);
    assert_eq!(
        *mac.hooks.closed.lock().expect("closed"),
        report.closed_task_ids
    );
}

// ---------------------------------------------------------------------------
// Normalisation N1–N8: each correction is a local change, queued and pushed.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn n1_a_cycle_of_projects_is_cut() {
    let (server, mac) = linked().await;
    server.put(subject_change("a", &stamp(1), None, None));
    server.put(subject_change("b", &stamp(2), None, None));
    mac.sync().await;
    server.put(subject_change("a", &stamp(10), Some("b"), None));
    server.put(subject_change("b", &stamp(11), Some("a"), None));
    let report = mac.sync().await;
    assert!(report.corrected >= 1);
    // The lowest (updated_at, id) member loses its parent.
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM subjects WHERE id = 'a' AND parent_id IS NULL"),
        1
    );
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM subjects WHERE id = 'b' AND parent_id = 'a'"),
        1
    );
    assert!(mac.outbox_has("subject", "a"));
    mac.sync().await;
    assert!(mac.outbox().is_empty());
    let pushed = server.get(Entity::Subject, "a").expect("a");
    assert_eq!(
        serde_json::to_value(&pushed).expect("json")["data"]["parent_id"],
        serde_json::Value::Null
    );
}

#[tokio::test]
async fn n2_a_sub_project_of_a_sub_project_moves_up() {
    let (server, mac) = linked().await;
    server.put(subject_change("a", &stamp(1), None, None));
    server.put(subject_change("b", &stamp(2), Some("a"), None));
    server.put(subject_change("c", &stamp(3), Some("b"), None));
    mac.sync().await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM subjects WHERE id = 'c' AND parent_id = 'a'"),
        1
    );
    assert!(mac.outbox_has("subject", "c"));
}

#[tokio::test]
async fn n3_a_cycle_of_tasks_is_cut() {
    let (server, mac) = linked().await;
    server.put(task_change(
        "x",
        &stamp(1),
        task_data(None, None, &stamp(1)),
    ));
    server.put(task_change(
        "y",
        &stamp(2),
        task_data(None, None, &stamp(2)),
    ));
    mac.sync().await;
    server.put(task_change(
        "x",
        &stamp(10),
        task_data(None, Some("y"), &stamp(1)),
    ));
    server.put(task_change(
        "y",
        &stamp(11),
        task_data(None, Some("x"), &stamp(2)),
    ));
    mac.sync().await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 'x' AND parent_id IS NULL"),
        1
    );
    assert!(mac.outbox_has("task", "x"));
}

#[tokio::test]
async fn n5_n6_a_child_task_lives_where_its_parent_lives() {
    let (server, mac) = linked().await;
    server.put(subject_change("p1", &stamp(1), None, None));
    server.put(subject_change("p2", &stamp(2), None, None));
    server.put(section_change("s1", &stamp(3), "p1"));
    let mut parent = task_data(Some("p1"), None, &stamp(4));
    parent.section_id = Some("s1".into());
    server.put(task_change("parent", &stamp(4), parent));
    server.put(task_change(
        "child",
        &stamp(5),
        task_data(Some("p2"), Some("parent"), &stamp(5)),
    ));
    mac.sync().await;
    // N5: the child follows its parent's project and section.
    assert_eq!(
        mac.count(
            "SELECT COUNT(*) FROM tasks WHERE id = 'child' AND subject_id = 'p1' \
             AND section_id = 's1'"
        ),
        1
    );
    assert!(mac.outbox_has("task", "child"));
    mac.sync().await;
    // N6: the section moves to another project; the tasks left behind lose it.
    server.put(section_change("s1", &stamp(20), "p2"));
    mac.sync().await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 'parent' AND section_id IS NULL"),
        1
    );
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM tasks WHERE id = 'child' AND section_id IS NULL"),
        1
    );
    assert!(mac.outbox_has("task", "parent"));
}

#[tokio::test]
async fn n7_n8_delete_wins_over_an_edit_under_a_deleted_project() {
    let (server, mac) = linked().await;
    let (p, sub, t, under_parent) = {
        let conn = mac.conn();
        let p = subject(&conn, "Alpha");
        let sub = crate::db::test_support::sub_project(&conn, &p, "Beta", None);
        let t = task(&conn, "In sub", Some(&sub), None);
        let parent = task(&conn, "Parent", None, None);
        let child = tasks::create_child(&conn, &parent, "Child").expect("child");
        (p, sub, t, (parent, child))
    };
    mac.sync().await;
    let deleted = "2099-01-01T00:00:00.000Z";
    server.put(subject_change(&p, deleted, None, Some(deleted)));
    let mut parent = task_data(None, None, deleted);
    parent.deleted_at = Some(deleted.into());
    server.put(task_change(&under_parent.0, deleted, parent));
    mac.sync().await;
    let deleted_at = |table: &str, id: &str| {
        mac.text(&format!("SELECT deleted_at FROM {table} WHERE id = '{id}'"))
    };
    // N7 then N8: the live sub-project and its task share the project's deletion stamp, so
    // restoring the project brings them back.
    assert_eq!(deleted_at("subjects", &sub).as_deref(), Some(deleted));
    assert_eq!(deleted_at("tasks", &t).as_deref(), Some(deleted));
    assert_eq!(
        deleted_at("tasks", &under_parent.1).as_deref(),
        Some(deleted)
    );
    assert!(mac.outbox_has("subject", &sub));
    assert!(mac.outbox_has("task", &t));
    subjects::restore(&mac.conn(), &p).expect("restore");
    assert_eq!(deleted_at("subjects", &sub), None);
    assert_eq!(deleted_at("tasks", &t), None);
}

#[tokio::test]
async fn a_normalised_database_needs_no_correction() {
    let (_server, mac) = linked().await;
    {
        let conn = mac.conn();
        let p = subject(&conn, "Alpha");
        let sub = crate::db::test_support::sub_project(&conn, &p, "Beta", None);
        let sec = section(&conn, &sub, "Front");
        let t = task(&conn, "Write", Some(&sub), Some(&sec));
        tasks::create_child(&conn, &t, "Child").expect("child");
    }
    let conn = mac.conn();
    assert_eq!(
        crate::sync::normalize::normalize(&conn).expect("normalize"),
        0
    );
}

/// Settings (docs/SYNC.md § 2.5): applied first, known, not queued; an invalid one (a string
/// `inbox_position`, a tombstone) is ignored.
#[tokio::test]
async fn pulled_settings_are_applied_and_invalid_ones_ignored() {
    use crate::db::{synced_settings, top_level};
    let (server, mac) = linked().await;
    let key = synced_settings::INBOX_POSITION;
    server.put(subject_change("a", &stamp(1), None, None));
    server.put(setting_change(key, &stamp(2), serde_json::json!(0.5)));
    server.put(setting_change(
        "theme_x",
        &stamp(3),
        serde_json::json!({ "x": 1 }),
    ));
    let report = mac.sync().await;
    assert_eq!(report.applied, 3);
    assert_eq!(
        synced_settings::inbox_position(&mac.conn()).expect("read"),
        Some(0.5)
    );
    assert_eq!(top_level::inbox_index(&mac.conn()).expect("index"), 0);
    assert_eq!(
        crate::sync::store::known(&mac.conn(), "setting", key)
            .expect("known")
            .as_deref(),
        Some(stamp(2).as_str())
    );
    assert!(mac.outbox().is_empty(), "an applied setting is not queued");
    assert_eq!(
        mac.text("SELECT value FROM synced_settings WHERE key = 'theme_x'")
            .as_deref(),
        Some("{\"x\":1}")
    );

    // A string position is invalid: ignored, the stored value stays.
    server.put(setting_change(key, &stamp(4), serde_json::json!("first")));
    let report = mac.sync().await;
    assert_eq!(report.applied, 0);
    assert_eq!(
        synced_settings::inbox_position(&mac.conn()).expect("read"),
        Some(0.5)
    );
    // A tombstone too (a setting is never deleted).
    server.put(tombstone(Entity::Setting, key, &stamp(5)));
    mac.sync().await;
    assert_eq!(
        synced_settings::inbox_position(&mac.conn()).expect("read"),
        Some(0.5)
    );
    assert!(mac.outbox().is_empty());
}

/// A newer pulled position replaces the local one; a local pending one is kept and pushed.
#[tokio::test]
async fn a_pending_local_setting_is_not_overwritten_by_a_pull() {
    use crate::db::synced_settings;
    let (server, mac) = linked().await;
    let key = synced_settings::INBOX_POSITION;
    synced_settings::set_inbox_position(&mac.conn(), 3.0).expect("local");
    server.put(setting_change(key, &stamp(1), serde_json::json!(1.0)));
    mac.sync().await;
    // The local version is newer than the 2020 stamp: it wins on the server.
    assert_eq!(
        synced_settings::inbox_position(&mac.conn()).expect("read"),
        Some(3.0)
    );
    let stored = server.get(Entity::Setting, key).expect("pushed");
    assert_eq!(stored.device_id(), "device-1");
    assert!(mac.outbox().is_empty());
}
