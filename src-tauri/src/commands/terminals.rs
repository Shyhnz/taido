//! Terminal commands. Thin: they delegate to the
//! terminal service, whose blocking work (environment, spawn, kill) runs off the main thread.
//!
//! `attach_terminal` is not exported through tauri-specta: its argument is a raw-bytes
//! `Channel<InvokeResponseBody>` (no JSON arrays of numbers), which specta cannot
//! describe. It is routed by `lib.rs` and wrapped by hand in `src/lib/ipc.ts`.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::app_state::AppState;
use crate::commands::data::{finish_detail, notify};
use crate::db::history;
use crate::db::tasks;
use crate::db::terminals as rows;
use crate::error::{AppError, AppResult};
use crate::events::DataScope;
use crate::model::*;

const TERMINAL_SCOPES: &[DataScope] = &[DataScope::Terminals, DataScope::Tasks];

/// Runs `f` with the app state on the blocking pool.
pub(crate) async fn blocking<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Internal(format!("blocking task failed: {e}")))?
}

fn notify_terminals(app: &AppHandle, state: &AppState, task_id: &str) {
    match state.db.lock() {
        Ok(conn) => notify(app, &conn, TERMINAL_SCOPES, Some(vec![task_id.to_string()])),
        Err(e) => log::warn!("cannot notify terminal change: {e}"),
    }
}

/// Opens a terminal on a task: resolves the working folder (`no_folder`, `folder_missing`),
/// spawns the process in a PTY and, for Claude, creates the `agent_sessions` row (Starting).
#[tauri::command]
#[specta::specta]
pub async fn open_terminal(app: AppHandle, input: OpenTerminalInput) -> AppResult<TerminalInfo> {
    let notify_app = app.clone();
    blocking(&app, move |state| {
        let info = state.terminals.open(&state.db, &input)?;
        notify_terminals(&notify_app, state, &info.task_id);
        state.sessions.launched(&info);
        Ok(info)
    })
    .await
}

/// Every terminal kept by the core, all tasks together (UI start and webview reload).
#[tauri::command]
#[specta::specta]
pub async fn list_terminals(state: State<'_, AppState>) -> AppResult<Vec<TerminalInfo>> {
    Ok(state.terminals.pty.list())
}

/// Writes UTF-8 text to the terminal (keystrokes, pastes).
#[tauri::command]
#[specta::specta]
pub async fn write_terminal(
    state: State<'_, AppState>,
    input: WriteTerminalInput,
) -> AppResult<()> {
    state
        .terminals
        .pty
        .write(&input.terminal_id, input.data.as_bytes())?;
    // A lone Escape in a Claude terminal that works or waits for a permission interrupts the
    // session.
    if let Err(e) = state.sessions.typed(&input.terminal_id, &input.data) {
        log::warn!("cannot apply Escape on terminal {}: {e}", input.terminal_id);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    input: ResizeTerminalInput,
) -> AppResult<()> {
    state
        .terminals
        .pty
        .resize(&input.terminal_id, input.cols, input.rows)
}

/// Stops streaming to the UI; the process keeps running and the buffer keeps filling.
#[tauri::command]
#[specta::specta]
pub async fn detach_terminal(state: State<'_, AppState>, terminal_id: String) -> AppResult<()> {
    match state.terminals.pty.detach(&terminal_id) {
        Err(AppError::NotFound(_)) => Ok(()),
        other => other,
    }
}

/// Closes a terminal: marks it closed by the user, then SIGTERM to its process group and
/// SIGKILL after 3 s. For an exited terminal, only forgets its tab.
#[tauri::command]
#[specta::specta]
pub async fn close_terminal(app: AppHandle, terminal_id: String) -> AppResult<()> {
    let notify_app = app.clone();
    blocking(&app, move |state| {
        if let Some(info) = state.terminals.close(&state.db, &terminal_id)? {
            notify_terminals(&notify_app, state, &info.task_id);
        }
        Ok(())
    })
    .await
}

/// Stores the folder chosen for a task's terminals at the right level: the
/// project's folder (`root_path`) when the task has a project without folder or inherits it
/// from the project; the task's override for a task without project or with an override;
/// the section's sub-folder when it inherits from the section and the path lies inside the
/// project folder (else the task's override).
#[tauri::command]
#[specta::specta]
pub async fn set_task_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SetTaskFolderInput,
) -> AppResult<TaskDetail> {
    let detail = {
        let conn = state.db.lock()?;
        rows::set_task_folder(&conn, &input)?;
        // The project's or the section's folder may have changed: other tasks too.
        notify(&app, &conn, &[DataScope::Subjects, DataScope::Tasks], None);
        tasks::detail(&conn, &input.task_id)?
    };
    finish_detail(&state, detail).await
}

/// Quits the app (after the UI's confirmation): terminals are marked closed by the user and
/// their sessions paused **before** the processes are stopped, then the app exits.
#[tauri::command]
#[specta::specta]
pub async fn quit_app(app: AppHandle) -> AppResult<()> {
    blocking(&app, |state| {
        state.terminals.shutdown(&state.db);
        Ok(())
    })
    .await?;
    app.exit(0);
    Ok(())
}

/// Replays the terminal's buffer into `on_data`, then streams its output there.
/// A terminal has a single subscriber: attaching replaces the previous one (webview reload).
#[tauri::command]
pub async fn attach_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<TerminalSize> {
    let sink = Box::new(move |bytes: Vec<u8>| on_data.send(InvokeResponseBody::Raw(bytes)).is_ok());
    state.terminals.pty.attach(&terminal_id, sink)
}

/// « Interrompre »: writes Escape (`\x1b`) to the session's terminal; the
/// session goes Idle and its permission queue is emptied.
#[tauri::command]
#[specta::specta]
pub async fn interrupt_agent(app: AppHandle, agent_session_id: String) -> AppResult<()> {
    blocking(&app, move |state| {
        let terminal_id = state.sessions.terminal_of(&agent_session_id)?;
        // The PTY write happens without the database lock.
        state
            .terminals
            .pty
            .write(&terminal_id, crate::session_service::ESCAPE.as_bytes())?;
        state.sessions.interrupt(&agent_session_id)
    })
    .await
}

/// Last hook events received, newest first (diagnostic panel).
#[tauri::command]
#[specta::specta]
pub async fn get_hook_events(
    state: State<'_, AppState>,
    limit: u32,
) -> AppResult<Vec<HookEventLog>> {
    // At most 10,000 (the table's cap).
    let conn = state.db.lock()?;
    rows::hook_events(&conn, limit)
}

/// The Claude conversations of a task, newest first (« Sessions Claude »).
#[tauri::command]
#[specta::specta]
pub async fn list_task_sessions(
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<Vec<SessionSummary>> {
    // Older sessions without recap get one in the background (option 4).
    state.summarizer.request(Some(&task_id));
    let conn = state.db.lock()?;
    tasks::ensure_exists(&conn, &task_id)?;
    history::sessions_of_task(&conn, &task_id, |terminal_id| {
        state
            .terminals
            .pty
            .info(terminal_id)
            .is_some_and(|t| t.running)
    })
}

/// What happened in one session, oldest first (its unfolded detail).
#[tauri::command]
#[specta::specta]
pub async fn get_session_exchanges(
    state: State<'_, AppState>,
    agent_session_id: String,
) -> AppResult<Vec<Exchange>> {
    let conn = state.db.lock()?;
    history::exchanges(&conn, &agent_session_id)
}

/// « Reprendre »: `claude --resume <id> --settings …` in a new tab of the task,
/// the session row reattached to it. `invalid` when it already runs in a tab or has no
/// message; `folder_missing` / `no_folder` like `open_terminal`.
#[tauri::command]
#[specta::specta]
pub async fn resume_session(app: AppHandle, input: ResumeSessionInput) -> AppResult<TerminalInfo> {
    let notify_app = app.clone();
    blocking(&app, move |state| {
        let info = state.terminals.resume(&state.db, &input)?;
        notify_terminals(&notify_app, state, &info.task_id);
        state.sessions.launched(&info);
        Ok(info)
    })
    .await
}

/// Renames a session of the history; `""` restores the automatic recap.
#[tauri::command]
#[specta::specta]
pub async fn rename_session(app: AppHandle, input: RenameSessionInput) -> AppResult<()> {
    let state = app.state::<AppState>();
    let conn = state.db.lock()?;
    let task_id = history::rename(&conn, &input.agent_session_id, &input.title)?;
    notify(
        &app,
        &conn,
        &[DataScope::Tasks, DataScope::Journal],
        Some(vec![task_id]),
    );
    Ok(())
}
