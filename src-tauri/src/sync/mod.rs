//! Sync with the server. Change tracking lives in SQLite
//! triggers (migrations 0010, 0011, 0016 and 0017); this module pushes the outbox, pulls and
//! applies the server's rows, moves the attachment files (`files`) and runs the
//! worker. Only `client` talks to the network, and nothing does until the user signs up, logs
//! in or asks for a password reset code.

pub mod apply;
pub mod client;
pub mod engine;
pub mod files;
pub mod model;
pub mod normalize;
pub mod rows;
pub mod service;
pub mod store;

#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod files_e2e_tests;
#[cfg(test)]
mod tests;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

pub use model::SyncStatus;

use crate::app_state::AppState;
use crate::events::{DataScope, SyncChanged};
use crate::sync::engine::SyncHooks;
use crate::sync::service::SyncEvents;

/// Number of change-tracking triggers: insert, update and delete on subjects, sections,
/// tasks, synced settings (0010, 0011) and the V2 tables board columns, time segments,
/// relations and attachments (0016).
pub const TRIGGER_COUNT: i64 = 30;

/// Change-tracking triggers present (`sync_%`). A migration that rebuilds a synced table
/// drops its triggers: the startup logs an error when some are missing.
pub fn trigger_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' \
         ESCAPE '\\'",
        [],
        |r| r.get(0),
    )
}

/// Startup check of the triggers (logged, never fatal).
pub fn check_triggers(conn: &Connection) {
    match trigger_count(conn) {
        Ok(TRIGGER_COUNT) => {}
        Ok(n) => log::error!(
            "sync: {n} change-tracking triggers instead of {TRIGGER_COUNT}: local changes \
             may not be synced"
        ),
        Err(e) => log::error!("sync: cannot check the change-tracking triggers: {e}"),
    }
}

/// Closes the terminals of the tasks a sync deletes or completes.
pub struct AppHooks(pub AppHandle);

impl SyncHooks for AppHooks {
    fn close_tasks(&self, task_ids: &[String]) {
        if let Some(state) = self.0.try_state::<AppState>() {
            state.terminals.close_for_tasks(&state.db, task_ids);
        }
    }
}

/// Emits the sync events to the UI.
/// What rows pulled from another device may change. Settings: the shared theme. Notes: a
/// task renamed or deleted elsewhere changes link chips and « Mentionné dans » too.
pub(crate) const SYNC_APPLIED_SCOPES: &[DataScope] = &[
    DataScope::Subjects,
    DataScope::Tasks,
    DataScope::Journal,
    DataScope::Settings,
    DataScope::Notes,
];

pub struct AppEvents(pub AppHandle);

impl SyncEvents for AppEvents {
    fn status_changed(&self, status: &SyncStatus) {
        let event = SyncChanged {
            status: status.clone(),
        };
        if let Err(e) = event.emit(&self.0) {
            log::warn!("cannot emit sync_changed: {e}");
        }
    }

    fn data_changed(&self, conn: &Connection) {
        crate::commands::data::notify(&self.0, conn, SYNC_APPLIED_SCOPES, None);
    }

    fn attachments_changed(&self, conn: &Connection, task_ids: &[String]) {
        crate::commands::data::notify(&self.0, conn, &[DataScope::Tasks], Some(task_ids.to_vec()));
    }

    fn notes_changed(&self, conn: &Connection) {
        crate::commands::data::notify(&self.0, conn, &[DataScope::Notes], None);
    }
}
