//! `run_once`, `link` and `unlink` against the fake server (docs/SYNC.md § 2.6–2.7, § 3.4–3.5).

use sync_proto::{Change, Entity, ErrorCode, EPOCH_STAMP};

use super::fake::{FakeServer, Scripted};
use super::*;
use crate::db::tasks;
use crate::db::test_support::{section, subject, task};
use crate::error::AppError;
use crate::model::SetCompletedInput;
use crate::sync::model::SyncErrorKind;
use crate::sync::store;

fn data_of(change: &Change) -> serde_json::Value {
    let v = serde_json::to_value(change).expect("json");
    v["data"].clone()
}

#[tokio::test]
async fn push_builds_the_rows_from_the_synced_columns() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let (s, sec, t) = {
        let conn = mac.conn();
        let s = subject(&conn, "Alpha");
        let sec = section(&conn, &s, "Front");
        let t = task(&conn, "Write", Some(&s), Some(&sec));
        (s, sec, t)
    };
    mac.link(&server).await;
    let report = mac.sync().await;
    assert_eq!(report.requests, 1);
    assert_eq!(report.pushed, 3);
    assert!(mac.outbox().is_empty());

    let pushed = server.get(Entity::Subject, &s).expect("subject");
    let data = data_of(&pushed);
    assert_eq!(data["name"], "Alpha");
    assert_eq!(data["color"], "violet");
    assert!(
        data.get("root_path").is_none(),
        "local-only column not sent"
    );
    assert_eq!(pushed.device_id(), "device-1");
    let section = data_of(&server.get(Entity::Section, &sec).expect("section"));
    assert_eq!(section["subject_id"], s.as_str());
    assert!(section.get("subpath").is_none());
    let pushed_task = server.get(Entity::Task, &t).expect("task");
    let task_data = data_of(&pushed_task);
    assert_eq!(task_data["title"], "Write");
    assert_eq!(task_data["section_id"], sec.as_str());
    assert!(task_data.get("workdir_override").is_none());
    // The pushed version is now the row's known version; the cursor follows the server.
    assert_eq!(
        store::known(&mac.conn(), "task", &t)
            .expect("known")
            .as_deref(),
        Some(pushed_task.updated_at())
    );
    assert_eq!(store::cursor(&mac.conn()).expect("cursor"), 3);
    assert_eq!(store::last_error(&mac.conn()).expect("error"), None);
}

#[tokio::test]
async fn a_large_outbox_goes_in_chunks_with_the_cursor_stored_after_each() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    {
        let conn = mac.conn();
        for i in 0..1200 {
            task(&conn, &format!("Task {i}"), None, None);
        }
    }
    mac.link(&server).await;
    let report = mac.sync().await;
    assert_eq!(report.requests, 3);
    assert_eq!(report.pushed, 1200);
    let state = server.state();
    let sizes: Vec<usize> = state.requests.iter().map(|r| r.changes.len()).collect();
    assert_eq!(sizes, vec![500, 500, 200]);
    // Each request carries the cursor stored after the previous one.
    let cursors: Vec<u64> = state.requests.iter().map(|r| r.cursor).collect();
    assert_eq!(cursors, vec![0, 500, 1000]);
    drop(state);
    assert!(mac.outbox().is_empty());
    assert_eq!(store::cursor(&mac.conn()).expect("cursor"), 1200);
}

#[tokio::test]
async fn pages_are_pulled_until_has_more_is_false() {
    let server = FakeServer::start().await;
    server.state().page_size = 2;
    for i in 0..5 {
        server.put(subject_change(&format!("s{i}"), &stamp(i), None, None));
    }
    let mac = Mac::new();
    mac.link(&server).await;
    let report = mac.sync().await;
    assert_eq!(report.requests, 3);
    assert_eq!(report.applied, 5);
    assert_eq!(mac.count("SELECT COUNT(*) FROM subjects"), 5);
    assert_eq!(store::cursor(&mac.conn()).expect("cursor"), 5);
    assert!(mac.outbox().is_empty(), "applied rows are not queued");
}

#[tokio::test]
async fn rejected_changes_are_dropped_from_the_outbox() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let (bad, good) = {
        let conn = mac.conn();
        (
            task(&conn, "Bad", None, None),
            task(&conn, "Good", None, None),
        )
    };
    server.state().reject_ids.insert(bad.clone());
    mac.link(&server).await;
    let report = mac.sync().await;
    assert_eq!(report.rejected, 1);
    assert!(mac.outbox().is_empty());
    assert!(server.get(Entity::Task, &bad).is_none());
    assert!(server.get(Entity::Task, &good).is_some());
    // Not stored: no known version for it.
    assert_eq!(
        store::known(&mac.conn(), "task", &bad).expect("known"),
        None
    );
}

#[tokio::test]
async fn an_invalid_local_row_is_dropped_without_blocking_the_sync() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let (bad, good) = {
        let conn = mac.conn();
        let bad = task(&conn, "Bad", None, None);
        conn.execute("UPDATE tasks SET due_time = '10:00' WHERE id = ?1", [&bad])
            .expect("time without date");
        (bad, task(&conn, "Good", None, None))
    };
    mac.link(&server).await;
    mac.sync().await;
    assert!(server.get(Entity::Task, &bad).is_none());
    assert!(server.get(Entity::Task, &good).is_some());
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn in_flight_edits_are_not_overwritten() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let t = task(&mac.conn(), "Mine", None, None);
    mac.link(&server).await;
    mac.sync().await;
    // Another device's newer version waits on the server; the Mac edits the task again while
    // its own push is in flight.
    let mut theirs = task_data(None, None, &stamp(1));
    theirs.title = "Theirs".into();
    server.put(task_change(&t, "2099-01-01T00:00:00.000Z", theirs));
    tasks::update(
        &mac.conn(),
        &crate::model::UpdateTaskInput {
            id: t.clone(),
            title: Some("Edited".into()),
            description: None,
        },
    )
    .expect("edit");
    let db = std::sync::Arc::clone(&mac.db);
    let id = t.clone();
    server.state().during_sync = Some(Box::new(move || {
        let conn = db.lock().expect("db");
        conn.execute("UPDATE tasks SET title = 'In flight' WHERE id = ?1", [&id])
            .expect("in-flight edit");
    }));
    mac.sync().await;
    // The server refused the older push and sent its version: skipped, the local edit stays
    // queued for the next run.
    assert_eq!(
        mac.text(&format!("SELECT title FROM tasks WHERE id = '{t}'"))
            .as_deref(),
        Some("In flight")
    );
    assert!(mac.outbox_has("task", &t));
}

#[tokio::test]
async fn local_only_columns_survive_an_apply() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let (s, sec, t) = {
        let conn = mac.conn();
        let s = subject(&conn, "Alpha");
        let sec = section(&conn, &s, "Front");
        let t = task(&conn, "Write", Some(&s), Some(&sec));
        conn.execute("UPDATE sections SET subpath = 'web' WHERE id = ?1", [&sec])
            .expect("subpath");
        conn.execute(
            "UPDATE tasks SET workdir_override = '/tmp/w' WHERE id = ?1",
            [&t],
        )
        .expect("override");
        (s, sec, t)
    };
    mac.link(&server).await;
    mac.sync().await;
    let later = "2099-01-01T00:00:00.000Z";
    server.put(subject_change(&s, later, None, None));
    server.put(section_change(&sec, later, &s));
    let mut data = task_data(Some(&s), None, later);
    data.section_id = Some(sec.clone());
    data.title = "Renamed".into();
    server.put(task_change(&t, later, data));
    mac.sync().await;
    assert_eq!(
        mac.text(&format!("SELECT root_path FROM subjects WHERE id = '{s}'"))
            .as_deref(),
        Some(crate::abs!("/tmp/Alpha"))
    );
    assert_eq!(
        mac.text(&format!("SELECT subpath FROM sections WHERE id = '{sec}'"))
            .as_deref(),
        Some("web")
    );
    assert_eq!(
        mac.text(&format!(
            "SELECT workdir_override FROM tasks WHERE id = '{t}'"
        ))
        .as_deref(),
        Some("/tmp/w")
    );
    assert_eq!(
        mac.text(&format!("SELECT title FROM tasks WHERE id = '{t}'"))
            .as_deref(),
        Some("Renamed")
    );
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn a_server_reset_rebuilds_the_union_and_newer_local_rows_win_back() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let t = task(&mac.conn(), "Before", None, None);
    mac.link(&server).await;
    mac.sync().await;
    tasks::update(
        &mac.conn(),
        &crate::model::UpdateTaskInput {
            id: t.clone(),
            title: Some("After".into()),
            description: None,
        },
    )
    .expect("edit");
    mac.sync().await;
    let latest = server.get(Entity::Task, &t).expect("task");
    // The server is restored from an older backup: older version of the task, new epoch.
    {
        let mut s = server.state();
        s.records.clear();
        s.max_rev = 0;
        s.epoch = "epoch-2".into();
    }
    let mut old = task_data(None, None, &stamp(0));
    old.title = "Before".into();
    server.put(task_change(&t, &stamp(0), old));
    let other = subject_change("from-backup", &stamp(1), None, None);
    server.put(other);

    let report = mac.sync().await;
    assert!(report.epoch_reset);
    assert_eq!(
        mac.text("SELECT value FROM settings WHERE key = 'sync_server_epoch'")
            .as_deref(),
        Some("\"epoch-2\"")
    );
    let restored = server.get(Entity::Task, &t).expect("task");
    assert_eq!(data_of(&restored)["title"], "After");
    assert_eq!(restored.updated_at(), latest.updated_at());
    assert_eq!(
        mac.text(&format!("SELECT title FROM tasks WHERE id = '{t}'"))
            .as_deref(),
        Some("After")
    );
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM subjects WHERE id = 'from-backup'"),
        1
    );
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn errors_are_mapped_and_keep_the_outbox() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    task(&mac.conn(), "Pending", None, None);
    mac.link(&server).await;
    let last_error = || store::last_error(&mac.conn()).expect("last error");

    server
        .state()
        .script
        .push_back(Scripted::Error(401, ErrorCode::Unauthorized));
    assert_eq!(mac.run().await, Err(SyncError::Unauthorized));
    assert_eq!(last_error(), Some(SyncErrorKind::Unauthorized));
    assert!(
        store::is_linked(&mac.conn()).expect("linked"),
        "stays linked"
    );

    server
        .state()
        .script
        .push_back(Scripted::Error(400, ErrorCode::UnsupportedProtocol));
    assert_eq!(mac.run().await, Err(SyncError::UnsupportedProtocol));
    assert_eq!(last_error(), Some(SyncErrorKind::UnsupportedProtocol));

    server
        .state()
        .script
        .push_back(Scripted::Error(500, ErrorCode::Internal));
    assert!(matches!(mac.run().await, Err(SyncError::Server(_))));
    assert_eq!(last_error(), Some(SyncErrorKind::Server));

    server.state().script.push_back(Scripted::Raw(
        200,
        "text/html",
        "<html>Just a moment…</html>",
    ));
    assert!(matches!(mac.run().await, Err(SyncError::Server(_))));
    server.state().script.push_back(Scripted::Raw(
        403,
        "text/html",
        "<html>Attention Required</html>",
    ));
    assert!(matches!(mac.run().await, Err(SyncError::Server(_))));
    assert_eq!(mac.outbox().len(), 1, "nothing lost");

    // A success clears the error.
    mac.sync().await;
    assert_eq!(last_error(), None);
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn an_unreachable_server_is_offline() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    task(&mac.conn(), "Pending", None, None);
    mac.link(&server).await;
    // Point the link at a port nobody listens on.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    };
    crate::db::settings::write(
        &mac.conn(),
        store::SERVER_URL,
        &format!("http://127.0.0.1:{port}"),
    )
    .expect("url");
    assert!(matches!(mac.run().await, Err(SyncError::Offline(_))));
    assert_eq!(store::last_error(&mac.conn()).expect("error"), None);
    assert_eq!(mac.outbox().len(), 1);
}

#[tokio::test]
async fn a_413_halves_the_chunk() {
    let server = FakeServer::start().await;
    server.state().max_changes = Some(100);
    let mac = Mac::new();
    {
        let conn = mac.conn();
        for i in 0..250 {
            task(&conn, &format!("Task {i}"), None, None);
        }
    }
    mac.link(&server).await;
    let report = mac.sync().await;
    assert_eq!(report.pushed, 250);
    assert!(mac.outbox().is_empty());
    let sizes: Vec<usize> = server
        .state()
        .requests
        .iter()
        .map(|r| r.changes.len())
        .collect();
    assert_eq!(sizes[..3], [250, 125, 62]);
    assert!(sizes.iter().skip(2).all(|&n| n <= 62));

    // Down to one change, still too large: error `server`.
    server.state().max_changes = Some(0);
    task(&mac.conn(), "Huge", None, None);
    assert!(matches!(mac.run().await, Err(SyncError::Server(_))));
}

#[tokio::test]
async fn link_validates_the_address_and_maps_login_errors() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    for bad in ["", "ftp://x", "http://example.com", "not a url", "https://"] {
        let result = engine::login(&mac.db, &mac.client, bad, fake::EMAIL, fake::PASSWORD).await;
        assert!(matches!(result, Err(AppError::Invalid(_))), "{bad}");
    }
    let result = engine::login(&mac.db, &mac.client, &server.base_url, fake::EMAIL, "wrong").await;
    assert!(matches!(result, Err(AppError::SyncAuth)));
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    };
    let result = engine::login(
        &mac.db,
        &mac.client,
        &format!("http://localhost:{port}"),
        fake::EMAIL,
        fake::PASSWORD,
    )
    .await;
    assert!(matches!(result, Err(AppError::SyncOffline(_))));
    assert!(!store::is_linked(&mac.conn()).expect("linked"));
    assert_eq!(
        engine::normalize_url(" https://todo.example.org/ ").expect("ok"),
        "https://todo.example.org"
    );
    // A trailing slash is dropped.
    engine::login(
        &mac.db,
        &mac.client,
        &format!("{}/", server.base_url),
        fake::EMAIL,
        fake::PASSWORD,
    )
    .await
    .expect("link");
    assert!(store::is_linked(&mac.conn()).expect("linked"));
}

#[tokio::test]
async fn link_with_no_known_version_enqueues_the_epoch_stamp() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let (s, t) = {
        let conn = mac.conn();
        let s = subject(&conn, "Old");
        (s.clone(), task(&conn, "Old task", Some(&s), None))
    };
    // Rows from before the change tracking: no outbox entry, no known version.
    mac.clear_outbox();
    mac.link(&server).await;
    let outbox = mac.outbox();
    assert_eq!(outbox.len(), 2);
    assert!(outbox.iter().all(|(_, _, at, _)| at == EPOCH_STAMP));
    // Accepted by a server that lacks them, losing to any real version.
    let mut theirs = task_data(Some(&s), None, &stamp(5));
    theirs.title = "Real".into();
    server.put(task_change(&t, &stamp(5), theirs));
    mac.sync().await;
    assert!(server.get(Entity::Subject, &s).is_some());
    assert_eq!(
        mac.text(&format!("SELECT title FROM tasks WHERE id = '{t}'"))
            .as_deref(),
        Some("Real")
    );
}

#[tokio::test]
async fn relinking_keeps_an_edit_made_while_unlinked() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let t = task(&mac.conn(), "Write", None, None);
    mac.link(&server).await;
    mac.sync().await;
    engine::unlink(&mac.db, &mac.client).await.expect("unlink");
    assert_eq!(server.state().logouts, 1);
    tasks::set_completed(
        &mac.conn(),
        &SetCompletedInput {
            id: t.clone(),
            completed: true,
        },
    )
    .expect("complete");
    let edit_stamp = mac.outbox()[0].2.clone();
    mac.link(&server).await;
    // The edit keeps its own stamp (never lowered to a known or epoch stamp).
    assert_eq!(mac.outbox()[0].2, edit_stamp);
    mac.sync().await;
    let stored = server.get(Entity::Task, &t).expect("task");
    assert_eq!(stored.updated_at(), edit_stamp);
    assert!(!data_of(&stored)["completed_at"].is_null());
    assert!(mac
        .text(&format!("SELECT completed_at FROM tasks WHERE id = '{t}'"))
        .is_some());
}

#[tokio::test]
async fn unlink_keeps_data_url_and_outbox() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let t = task(&mac.conn(), "Write", None, None);
    mac.link(&server).await;
    mac.sync().await;
    task(&mac.conn(), "Later", None, None);
    engine::unlink(&mac.db, &mac.client).await.expect("unlink");
    {
        let conn = mac.conn();
        assert!(!store::is_linked(&conn).expect("linked"));
        let status = store::status(&conn, false, false).expect("status");
        assert_eq!(status.state, crate::sync::model::SyncState::Unlinked);
        assert_eq!(status.server_url.as_deref(), Some(server.base_url.as_str()));
        assert_eq!(status.pending, 1);
        assert!(store::known(&conn, "task", &t).expect("known").is_some());
    }
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks"), 2);
    assert_eq!(mac.run().await, Err(SyncError::NotLinked));
}

#[tokio::test]
async fn pulled_projects_get_their_folders() {
    let server = FakeServer::start().await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(subject_change("sub", &stamp(2), Some("p"), None));
    let mac = Mac::new();
    mac.link(&server).await;
    mac.sync().await;
    let root = mac.docs.path().join(crate::db::workspace::FOLDER_NAME);
    assert!(root.join("Projet p").is_dir());
    assert!(root.join("Projet p").join("Projet sub").is_dir());
    // Creating the folders writes local-only columns: nothing to push.
    assert!(mac.outbox().is_empty());
}

#[tokio::test]
async fn deleting_a_section_on_the_server_keeps_its_tasks() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let (s, sec, t) = {
        let conn = mac.conn();
        let s = subject(&conn, "Alpha");
        let sec = section(&conn, &s, "Front");
        (
            s.clone(),
            sec.clone(),
            task(&conn, "Write", Some(&s), Some(&sec)),
        )
    };
    mac.link(&server).await;
    mac.sync().await;
    server.put(tombstone(Entity::Section, &sec, &stamp(999)));
    mac.sync().await;
    assert_eq!(mac.count("SELECT COUNT(*) FROM sections"), 0);
    assert_eq!(
        mac.text(&format!("SELECT subject_id FROM tasks WHERE id = '{t}'"))
            .as_deref(),
        Some(s.as_str())
    );
}

#[tokio::test]
async fn a_run_whose_device_is_linked_again_in_flight_writes_nothing_for_the_old_link() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let t = task(&mac.conn(), "Local", None, None);
    mac.link(&server).await;
    server.put(subject_change("p", &stamp(1), None, None));
    // While the request is in flight, the user unlinks and links to another server.
    let db = std::sync::Arc::clone(&mac.db);
    server.state().during_sync = Some(Box::new(move || {
        let conn = db.lock().expect("db");
        store::clear_link(&conn).expect("unlink");
        store::save_link(
            &conn,
            &store::Link {
                server_url: "https://other.test".into(),
                token: "new-token".into(),
                device_id: "new-device".into(),
                server_epoch: "other-epoch".into(),
            },
        )
        .expect("link");
    }));
    let result = mac.run().await;
    assert_eq!(result, Err(SyncError::Superseded));
    let conn = mac.conn();
    assert_eq!(store::cursor(&conn).expect("cursor"), 0);
    assert_eq!(
        store::link(&conn)
            .expect("link")
            .map(|l| l.token)
            .as_deref(),
        Some("new-token")
    );
    assert_eq!(store::last_error(&conn).expect("error"), None);
    drop(conn);
    assert!(
        mac.outbox_has("task", &t),
        "the push only reached the old server"
    );
    assert_eq!(mac.count("SELECT COUNT(*) FROM subjects"), 0);
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM settings WHERE key = 'sync_last_success_at'"),
        0
    );
}

#[tokio::test]
async fn a_run_unlinked_in_flight_sends_no_further_request() {
    let server = FakeServer::start().await;
    server.state().page_size = 1;
    let mac = Mac::new();
    mac.link(&server).await;
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(subject_change("q", &stamp(2), None, None));
    let db = std::sync::Arc::clone(&mac.db);
    server.state().during_sync = Some(Box::new(move || {
        store::clear_link(&db.lock().expect("db")).expect("unlink");
    }));
    assert_eq!(mac.run().await, Err(SyncError::Superseded));
    assert_eq!(server.state().requests.len(), 1);
    assert_eq!(mac.count("SELECT COUNT(*) FROM subjects"), 0);
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM settings WHERE key = 'sync_cursor'"),
        0
    );
}

#[tokio::test]
async fn linking_again_forgets_the_last_success_of_the_old_link() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    mac.link(&server).await;
    mac.sync().await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM settings WHERE key = 'sync_last_success_at'"),
        1
    );
    mac.link(&server).await;
    assert_eq!(
        mac.count("SELECT COUNT(*) FROM settings WHERE key = 'sync_last_success_at'"),
        0
    );
}

/// The inbox position: a local write is pushed and
/// leaves the outbox; a link re-enqueues `synced_settings`; an epoch reset sends it again.
#[tokio::test]
async fn the_inbox_position_is_pushed_re_enqueued_and_resent_after_a_reset() {
    use crate::db::{synced_settings, top_level};
    let key = synced_settings::INBOX_POSITION;
    let server = FakeServer::start().await;
    let mac = Mac::new();
    {
        let conn = mac.conn();
        subject(&conn, "Alpha");
        top_level::reorder(&conn, &top_level::TopItem::Inbox, 0).expect("inbox first");
    }
    // Rows from before the link: re-enqueued with the epoch stamp, the setting included.
    mac.clear_outbox();
    mac.link(&server).await;
    assert!(mac.outbox_has("setting", key));
    mac.sync().await;
    assert!(mac.outbox().is_empty());
    let pushed = server.get(Entity::Setting, key).expect("pushed");
    assert_eq!(data_of(&pushed), serde_json::json!({ "value": 0.0 }));

    // A later move is pushed with a real stamp.
    synced_settings::set_inbox_position(&mac.conn(), 5.0).expect("move");
    assert!(mac.outbox_has("setting", key));
    mac.sync().await;
    assert!(mac.outbox().is_empty());
    let pushed = server.get(Entity::Setting, key).expect("pushed");
    assert_eq!(data_of(&pushed)["value"], 5.0);
    assert_ne!(pushed.updated_at(), EPOCH_STAMP);

    // The server loses everything: the setting is sent again.
    {
        let mut s = server.state();
        s.records.clear();
        s.max_rev = 0;
        s.epoch = "epoch-2".into();
    }
    let report = mac.sync().await;
    assert!(report.epoch_reset);
    assert_eq!(
        data_of(&server.get(Entity::Setting, key).expect("resent"))["value"],
        5.0
    );
}

/// A device that never moved « Sans projet » has no setting row: nothing is sent for it.
#[tokio::test]
async fn an_unset_inbox_position_is_never_sent() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    subject(&mac.conn(), "Alpha");
    mac.link(&server).await;
    mac.sync().await;
    assert!(server
        .get(Entity::Setting, crate::db::synced_settings::INBOX_POSITION)
        .is_none());
}
