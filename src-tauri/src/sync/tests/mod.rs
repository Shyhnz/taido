//! Tests of the sync module (docs/SYNC.md § 9 B). The engine runs against `fake::FakeServer`
//! on 127.0.0.1; databases are in memory, folders in temp dirs.

mod apply_tests;
mod engine_tests;
mod fake;
mod files_tests;
mod migration_tests;
mod notes_tests;
mod service_tests;
mod v2_tests;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use sync_proto::{Change, SectionData, SubjectData, TaskData, Versioned};

use crate::db::open_in_memory;
use crate::sync::client::SyncClient;
use crate::sync::engine::{self, RunReport, SyncError, SyncHooks};

use fake::FakeServer;

/// Records the tasks whose terminals the engine closes.
#[derive(Default)]
pub struct RecordingHooks {
    pub closed: Mutex<Vec<String>>,
}

impl SyncHooks for RecordingHooks {
    fn close_tasks(&self, task_ids: &[String]) {
        self.closed
            .lock()
            .expect("closed")
            .extend(task_ids.iter().cloned());
    }
}

/// Sync events, ignored (the file job's tests).
pub struct QuietEvents;

impl crate::sync::service::SyncEvents for QuietEvents {
    fn status_changed(&self, _status: &crate::sync::model::SyncStatus) {}
    fn data_changed(&self, _conn: &Connection) {}
}

/// One Mac: its database, its documents folder, its client and hooks.
pub struct Mac {
    pub db: Arc<Mutex<Connection>>,
    pub docs: tempfile::TempDir,
    pub client: SyncClient,
    pub hooks: RecordingHooks,
}

impl Mac {
    pub fn new() -> Mac {
        Mac {
            db: Arc::new(Mutex::new(open_in_memory().expect("db"))),
            docs: tempfile::tempdir().expect("documents"),
            client: SyncClient::new(),
            hooks: RecordingHooks::default(),
        }
    }

    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().expect("db lock")
    }

    pub async fn link(&self, server: &FakeServer) {
        engine::login(
            &self.db,
            &self.client,
            &server.base_url,
            fake::EMAIL,
            fake::PASSWORD,
        )
        .await
        .expect("link");
    }

    pub async fn run(&self) -> Result<RunReport, SyncError> {
        engine::run_once(&self.db, self.docs.path(), &self.client, &self.hooks).await
    }

    pub async fn sync(&self) -> RunReport {
        self.run().await.expect("sync")
    }

    pub fn count(&self, sql: &str) -> i64 {
        self.conn().query_row(sql, [], |r| r.get(0)).expect(sql)
    }

    pub fn text(&self, sql: &str) -> Option<String> {
        self.conn().query_row(sql, [], |r| r.get(0)).expect(sql)
    }

    /// `(entity, id, changed_at, purged)` of the outbox, by entity and id.
    pub fn outbox(&self) -> Vec<(String, String, String, bool)> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT entity, id, changed_at, purged FROM sync_outbox ORDER BY entity, id")
            .expect("prepare");
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .expect("query");
        rows.collect::<Result<_, _>>().expect("rows")
    }

    pub fn outbox_has(&self, entity: &str, id: &str) -> bool {
        self.outbox()
            .iter()
            .any(|(e, i, _, _)| e == entity && i == id)
    }

    /// Clears the outbox (as if everything was synced).
    pub fn clear_outbox(&self) {
        self.conn()
            .execute("DELETE FROM sync_outbox", [])
            .expect("clear outbox");
    }
}

pub fn stamp(n: u32) -> String {
    format!("2020-01-01T10:00:{:02}.{:03}Z", n / 1000, n % 1000)
}

pub fn subject_change(id: &str, at: &str, parent: Option<&str>, deleted: Option<&str>) -> Change {
    Change::Subject(Versioned {
        id: id.into(),
        updated_at: at.into(),
        device_id: "other-device".into(),
        data: Some(SubjectData {
            name: format!("Projet {id}"),
            color: "teal".into(),
            parent_id: parent.map(String::from),
            position: 1.0,
            created_at: at.into(),
            deleted_at: deleted.map(String::from),
            is_group: false,
        }),
    })
}

pub fn section_change(id: &str, at: &str, subject: &str) -> Change {
    Change::Section(Versioned {
        id: id.into(),
        updated_at: at.into(),
        device_id: "other-device".into(),
        data: Some(SectionData {
            subject_id: subject.into(),
            name: format!("Section {id}"),
            position: 1.0,
            created_at: at.into(),
        }),
    })
}

pub fn task_data(subject: Option<&str>, parent: Option<&str>, at: &str) -> TaskData {
    TaskData {
        subject_id: subject.map(String::from),
        section_id: None,
        parent_id: parent.map(String::from),
        title: "Tâche".into(),
        description: String::new(),
        due_date: None,
        due_time: None,
        priority: 1,
        completed_at: None,
        position: 1.0,
        created_at: at.into(),
        deleted_at: None,
        board_column_id: None,
    }
}

pub fn task_change(id: &str, at: &str, data: TaskData) -> Change {
    Change::Task(Versioned {
        id: id.into(),
        updated_at: at.into(),
        device_id: "other-device".into(),
        data: Some(data),
    })
}

pub fn setting_change(key: &str, at: &str, value: serde_json::Value) -> Change {
    Change::Setting(Versioned {
        id: key.into(),
        updated_at: at.into(),
        device_id: "other-device".into(),
        data: Some(sync_proto::SettingData { value }),
    })
}

pub fn tombstone(entity: sync_proto::Entity, id: &str, at: &str) -> Change {
    fn gone<T>(id: &str, at: &str) -> Versioned<T> {
        Versioned {
            id: id.into(),
            updated_at: at.into(),
            device_id: "other-device".into(),
            data: None,
        }
    }
    match entity {
        sync_proto::Entity::Subject => Change::Subject(gone(id, at)),
        sync_proto::Entity::Section => Change::Section(gone(id, at)),
        sync_proto::Entity::Task => Change::Task(gone(id, at)),
        sync_proto::Entity::Setting => Change::Setting(gone(id, at)),
        sync_proto::Entity::BoardColumn => Change::BoardColumn(gone(id, at)),
        sync_proto::Entity::TimeSegment => Change::TimeSegment(gone(id, at)),
        sync_proto::Entity::Relation => Change::Relation(gone(id, at)),
        sync_proto::Entity::Attachment => Change::Attachment(gone(id, at)),
        sync_proto::Entity::NoteGroup => Change::NoteGroup(gone(id, at)),
        sync_proto::Entity::NotePage => Change::NotePage(gone(id, at)),
        sync_proto::Entity::NoteAttachment => Change::NoteAttachment(gone(id, at)),
    }
}
