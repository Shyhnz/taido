//! The sync service (docs/SYNC.md § 3.2, § 3.6): purge after the first successful run,
//! pokes, interval, status events.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;

use super::fake::{self, FakeServer};
use super::*;
use crate::db::test_support::task;
use crate::sync::model::{SyncState, SyncStatus};
use crate::sync::service::{SyncEvents, SyncService};

#[derive(Default)]
struct RecordingEvents {
    statuses: Mutex<Vec<SyncStatus>>,
    data_changed: Mutex<usize>,
}

impl SyncEvents for RecordingEvents {
    fn status_changed(&self, status: &SyncStatus) {
        self.statuses.lock().expect("statuses").push(status.clone());
    }

    fn data_changed(&self, _conn: &Connection) {
        *self.data_changed.lock().expect("data") += 1;
    }
}

fn service(mac: &Mac, events: &Arc<RecordingEvents>, poke: Duration) -> Arc<SyncService> {
    SyncService::with_poke_delay(
        Arc::clone(&mac.db),
        mac.docs.path().to_path_buf(),
        SyncClient::new(),
        Arc::new(RecordingHooks::default()),
        Arc::clone(events) as Arc<dyn SyncEvents>,
        poke,
    )
}

/// Soft-deletes a task two days ago (due for the 24 h purge).
fn old_deleted_task(conn: &Connection) -> String {
    let t = task(conn, "Old", None, None);
    conn.execute(
        "UPDATE tasks SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1",
        [&t],
    )
    .expect("delete");
    t
}

#[tokio::test]
async fn the_purge_runs_after_the_first_successful_run_then_pokes() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let events = Arc::new(RecordingEvents::default());
    let sync = service(&mac, &events, Duration::from_millis(50));

    // Unlinked: a run does nothing and purges nothing.
    let old = old_deleted_task(&mac.conn());
    let status = sync.run().await;
    assert_eq!(status.state, SyncState::Unlinked);
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks"), 1);

    let status = sync
        .login(&fake::account(&server.base_url))
        .await
        .expect("link");
    assert_eq!(status.state, SyncState::Idle);
    // The first successful run purges, then the tombstone goes out with the next run.
    let status = sync.run().await;
    assert_eq!(status.state, SyncState::Idle);
    assert!(status.last_sync_at.is_some());
    assert_eq!(mac.count("SELECT COUNT(*) FROM tasks"), 0);
    assert!(mac.outbox_has("task", &old));
    assert!(*events.data_changed.lock().expect("data") >= 1);
    let states: Vec<SyncState> = events
        .statuses
        .lock()
        .expect("statuses")
        .iter()
        .map(|s| s.state)
        .collect();
    assert!(states.contains(&SyncState::Syncing));

    // The worker picks the poke up.
    tokio::spawn(Arc::clone(&sync).worker());
    for _ in 0..200 {
        if mac.outbox().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(mac.outbox().is_empty());
    assert!(server
        .get(sync_proto::Entity::Task, &old)
        .is_some_and(|c| c.is_tombstone()));

    // Once per session only.
    let again = old_deleted_task(&mac.conn());
    sync.run().await;
    assert_eq!(
        mac.count(&format!("SELECT COUNT(*) FROM tasks WHERE id = '{again}'")),
        1
    );
}

#[tokio::test]
async fn a_poke_runs_a_sync_only_when_something_is_pending() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let events = Arc::new(RecordingEvents::default());
    let sync = service(&mac, &events, Duration::from_millis(30));
    sync.login(&fake::account(&server.base_url))
        .await
        .expect("link");
    tokio::spawn(Arc::clone(&sync).worker());
    // The run started by the link.
    for _ in 0..200 {
        if !server.state().requests.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let before = server.state().requests.len();
    assert!(before >= 1);

    // Nothing pending: no run.
    sync.poke(&mac.conn());
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(server.state().requests.len(), before);

    // A local change: one run, 30 ms later.
    {
        let conn = mac.conn();
        task(&conn, "New", None, None);
        sync.poke(&conn);
    }
    for _ in 0..200 {
        if mac.outbox().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(mac.outbox().is_empty());
    assert_eq!(server.state().requests.len(), before + 1);
}

#[tokio::test]
async fn interval_and_unlink_update_the_status() {
    let server = FakeServer::start().await;
    let mac = Mac::new();
    let events = Arc::new(RecordingEvents::default());
    let sync = service(&mac, &events, Duration::from_secs(10));
    assert!(sync.set_interval(7).is_err());
    let status = sync.set_interval(15).expect("interval");
    assert_eq!(status.interval_minutes, 15);
    assert_eq!(status.state, SyncState::Unlinked);
    sync.login(&fake::account(&server.base_url))
        .await
        .expect("link");
    let status = sync.unlink().await.expect("unlink");
    assert_eq!(status.state, SyncState::Unlinked);
    assert_eq!(status.interval_minutes, 15);
    assert_eq!(status.server_url.as_deref(), Some(server.base_url.as_str()));
    assert_eq!(
        events.statuses.lock().expect("statuses").last(),
        Some(&status)
    );
}

#[tokio::test]
async fn an_offline_run_shows_offline_then_recovers() {
    let mac = Mac::new();
    let events = Arc::new(RecordingEvents::default());
    let sync = service(&mac, &events, Duration::from_secs(10));
    let server = FakeServer::start().await;
    sync.login(&fake::account(&server.base_url))
        .await
        .expect("link");
    let url = server.base_url.clone();
    drop(server);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let status = sync.run().await;
    assert_eq!(status.state, SyncState::Offline);
    assert_eq!(status.error_kind, None);
    // The server comes back (another port: the URL is updated as a relink would).
    let server = FakeServer::start().await;
    assert_ne!(server.base_url, url);
    crate::db::settings::write(
        &mac.conn(),
        crate::sync::store::SERVER_URL,
        &server.base_url,
    )
    .expect("url");
    let status = sync.run().await;
    assert_eq!(status.state, SyncState::Idle);
}

#[tokio::test]
async fn a_run_failing_after_applied_chunks_still_refreshes_the_ui() {
    let server = FakeServer::start().await;
    server.state().page_size = 1;
    let mac = Mac::new();
    let events = Arc::new(RecordingEvents::default());
    let sync = service(&mac, &events, Duration::from_secs(60));
    sync.login(&fake::account(&server.base_url))
        .await
        .expect("link");
    server.put(subject_change("p", &stamp(1), None, None));
    server.put(subject_change("q", &stamp(2), None, None));
    // The second request of the run fails: the first page stays applied.
    let calls = Arc::new(Mutex::new(0usize));
    let state = Arc::clone(&server.state);
    server.state().during_sync = Some(Box::new(move || {
        let mut n = calls.lock().expect("calls");
        *n += 1;
        if *n == 2 {
            state
                .lock()
                .expect("fake state")
                .script
                .push_back(fake::Scripted::Error(500, sync_proto::ErrorCode::Internal));
        }
    }));
    let before = *events.data_changed.lock().expect("data");
    let status = sync.run().await;
    assert_eq!(status.state, SyncState::Error);
    assert_eq!(mac.count("SELECT COUNT(*) FROM subjects WHERE id = 'p'"), 1);
    assert!(*events.data_changed.lock().expect("data") > before);
}

#[test]
fn account_info_ignores_unknown_plan_field() {
    // The cached `sync_account` JSON of an older build still carries `plan`.
    let cached = r#"{"email":"a@example.com","plan":"pro","emailVerified":true}"#;
    let info: crate::sync::model::AccountInfo =
        serde_json::from_str(cached).expect("legacy plan ignored");
    assert_eq!(info.email, "a@example.com");
    assert!(info.email_verified);
}
