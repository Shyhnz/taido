//! Events emitted by the core. The UI invalidates its queries when they arrive.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::model::{Counts, Ring, TaskLine};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DataScope {
    Subjects,
    Tasks,
    Journal,
    Terminals,
    Settings,
    /// Project notebooks: groups, pages, their images (query `notebook`).
    Notes,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DataChanged {
    pub scopes: Vec<DataScope>,
    /// Tasks whose detail changed, when known.
    pub task_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CountsChanged {
    pub counts: Counts,
}

/// A terminal's process exited. `clean` = exit code 0 or closed by the user.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExited {
    pub terminal_id: String,
    pub task_id: String,
    pub exit_code: Option<i32>,
    pub clean: bool,
}

/// ⌘Q (menu « Quitter ») was chosen: the window is shown and the UI confirms when terminals
/// are running, then calls `quit_app`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct QuitRequested {}

/// The ring or the second line of a task changed. Batched: at most one per task
/// every 50 ms. The UI updates the task in place, then refetches lazily.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TaskStateChanged {
    pub task_id: String,
    pub subject_id: Option<String>,
    pub ring: Ring,
    /// Second line of the row, as in `TaskRow.line`.
    pub line: Option<TaskLine>,
    /// When the change happened.
    pub at: String,
}

/// A notification was clicked: the UI opens the task on the terminal of the
/// session, or on its panel when the terminal is unknown.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct NotificationOpened {
    pub task_id: String,
    pub terminal_id: Option<String>,
}

/// The sync status changed.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncChanged {
    pub status: crate::sync::SyncStatus,
}

/// The dictation changed: model download progress, recording started or stopped
///.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChanged {
    pub status: crate::voice::VoiceStatus,
}

/// Loudness of the microphone while dictating, 0 to 1, about 16 times a second.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLevel {
    pub level: f32,
}

/// A question to a project progressed (« Demander au projet »): a step, its answer, a failure
/// or its stop. The last one of a question is `answer`, `failed` or `stopped`.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AskUpdated {
    pub ask_id: String,
    pub update: crate::ask::AskUpdate,
}
