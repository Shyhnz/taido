//! Terminals, Claude sessions and hook events.
//!
//! A `terminals` row is written before its process starts and closed (`closed_at`) when the
//! process exits or the user closes it. Rows still open at startup are orphans of a crash.
//! Session states are set here at launch (Starting), on quit (Paused) and for orphans
//! (Crashed), in bulk; every other change goes through the state machine
//! (`state::machine`, `session_service`).

use std::path::{Component, Path};

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{agent_sessions, now_utc, sections, subjects, tasks};
use crate::error::{AppError, AppResult};
use crate::model::{
    Agent, HookEventLog, PermissionMode, SetTaskFolderInput, TerminalKind, WorkdirSource,
};
use crate::state::machine::{transition, Event};

/// Hook events kept for diagnostics: 7 days, at most 10,000 rows.
const HOOK_EVENTS_MAX_ROWS: i64 = 10_000;
const HOOK_EVENTS_MAX_DAYS: i64 = 7;

pub struct NewTerminal<'a> {
    pub id: &'a str,
    pub task_id: &'a str,
    pub kind: TerminalKind,
    pub command: Option<&'a str>,
    pub cwd: &'a str,
    pub opened_at: &'a str,
}

pub struct NewSession<'a> {
    pub id: &'a str,
    pub task_id: &'a str,
    pub conversation_id: &'a str,
    pub agent: Agent,
    pub terminal_id: &'a str,
    pub permission_mode: Option<PermissionMode>,
    pub add_task_context: bool,
    pub at: &'a str,
}

/// Inserts the terminal row, and for Claude its session row in state Starting, in one
/// transaction (the hooks that follow find them).
pub fn insert(
    conn: &Connection,
    t: &NewTerminal<'_>,
    session: Option<&NewSession<'_>>,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let position: f64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM terminals WHERE task_id = ?1",
        [t.task_id],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO terminals (id, task_id, kind, command, cwd, position, opened_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            t.id,
            t.task_id,
            t.kind.as_str(),
            t.command,
            t.cwd,
            position,
            t.opened_at
        ],
    )?;
    if let Some(s) = session {
        tx.execute(
            "INSERT INTO agent_sessions (id, task_id, conversation_id, current_terminal_id, \
             state, permission_mode, add_task_context, state_changed_at, started_at, updated_at, \
             agent) \
             VALUES (?1, ?2, ?3, ?4, 'starting', ?5, ?6, ?7, ?7, ?7, ?8)",
            params![
                s.id,
                s.task_id,
                s.conversation_id,
                s.terminal_id,
                s.permission_mode.map(PermissionMode::as_str),
                s.add_task_context,
                s.at,
                s.agent.as_str()
            ],
        )?;
        // Claude on a task « À faire » puts it « En cours », once.
        crate::db::board_columns::advance_on_claude(&tx, s.task_id)?;
    }
    tx.commit()?;
    Ok(())
}

/// Removes the rows of a terminal whose process could not start.
pub fn delete_unstarted(conn: &Connection, terminal_id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM agent_sessions WHERE current_terminal_id = ?1",
        [terminal_id],
    )?;
    tx.execute("DELETE FROM terminals WHERE id = ?1", [terminal_id])?;
    tx.commit()?;
    Ok(())
}

/// The user closes the terminal: marked **before** the process is stopped, so that its exit
/// is not taken for a crash. No-op on an already closed terminal.
pub fn mark_closed_by_user(conn: &Connection, terminal_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE terminals SET closed_by_user = 1, closed_at = ?2 \
         WHERE id = ?1 AND closed_at IS NULL",
        params![terminal_id, now_utc()],
    )?;
    Ok(())
}

/// The process exited: closes the terminal (keeping an earlier `closed_at`) and ends the
/// session it was running. Returns whether the user had closed it.
pub fn mark_exited(
    conn: &Connection,
    terminal_id: &str,
    exit_code: Option<i32>,
) -> AppResult<bool> {
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE terminals SET closed_at = COALESCE(closed_at, ?2), exit_code = ?3 WHERE id = ?1",
        params![terminal_id, now, exit_code],
    )?;
    tx.execute(
        "UPDATE agent_sessions SET ended_at = ?2, updated_at = ?2 \
         WHERE current_terminal_id = ?1 AND ended_at IS NULL",
        params![terminal_id, now],
    )?;
    let by_user: Option<bool> = tx
        .query_row(
            "SELECT closed_by_user FROM terminals WHERE id = ?1",
            [terminal_id],
            |r| r.get(0),
        )
        .optional()?;
    tx.commit()?;
    Ok(by_user.unwrap_or(false))
}

/// ⌘Q: every open terminal is closed by the user and its live session paused,
/// **before** the processes are stopped. Returns the number of terminals. Same result as
/// the state machine's `AppQuit` (live → Paused, permission queue emptied).
pub fn pause_all_open(conn: &Connection) -> AppResult<usize> {
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    // Quitting stops the chronos (before the sessions pause).
    crate::db::time_segments::close_all(&tx, &now, crate::model::ChronoStop::AppClosed)?;
    let lang = crate::i18n::current_language(&tx);
    for row in agent_sessions::with_open_terminal(&tx)? {
        let (next, _) = transition(lang, &row.session, &Event::AppQuit, &now);
        if next != row.session {
            agent_sessions::save(&tx, &row.id, &next, &now)?;
        }
    }
    let n = tx.execute(
        "UPDATE terminals SET closed_by_user = 1, closed_at = ?1 WHERE closed_at IS NULL",
        [&now],
    )?;
    tx.commit()?;
    Ok(n)
}

/// At startup: terminals still open belong to a crashed run of the app. They are
/// closed and their live sessions become Crashed. Returns the number of orphans.
pub fn close_orphans(conn: &Connection) -> AppResult<usize> {
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE agent_sessions SET state = 'paused', waiting_kind = NULL, \
         pending_permission = NULL, error_kind = NULL, ended_at = ?1, \
         state_changed_at = ?1, updated_at = ?1 \
         WHERE ended_at IS NULL AND state <> 'paused' AND current_terminal_id IN \
         (SELECT id FROM terminals WHERE closed_at IS NULL)",
        [&now],
    )?;
    let n = tx.execute(
        "UPDATE terminals SET closed_at = ?1 WHERE closed_at IS NULL",
        [&now],
    )?;
    tx.commit()?;
    Ok(n)
}

/// At startup, after [`close_orphans`]: a session still in a live state whose terminal is
/// closed (or gone) is settled as history (Paused: no tab, no state;
/// a crash still reads from `ended_cleanly = 0` and `closed_by_user = 0`). Repairs rows written before the state
/// machine existed. The state dates from when the session really stopped
/// (`ended_at`, else the terminal's `closed_at`), not from this repair. Returns the number of
/// sessions settled.
pub fn settle_stale_sessions(conn: &Connection) -> AppResult<usize> {
    let now = now_utc();
    let n = conn.execute(
        "UPDATE agent_sessions SET \
         state = 'paused', \
         waiting_kind = NULL, pending_permission = NULL, \
         ended_at = COALESCE(ended_at, ?1), \
         state_changed_at = COALESCE(ended_at, (SELECT closed_at FROM terminals \
           WHERE terminals.id = agent_sessions.current_terminal_id), ?1), \
         updated_at = ?1 \
         WHERE state <> 'paused' AND (current_terminal_id IS NULL \
           OR current_terminal_id NOT IN (SELECT id FROM terminals WHERE closed_at IS NULL))",
        [&now],
    )?;
    Ok(n)
}

/// The user closed the tab of an exited Claude terminal: a Crashed session there becomes
/// history (Paused; `ended_cleanly` stays 0, so the history can still tell it crashed).
/// By design: the « ! » lasts as long as the tab.
pub fn settle_crashed_tab(conn: &Connection, terminal_id: &str) -> AppResult<usize> {
    let now = now_utc();
    let n = conn.execute(
        "UPDATE agent_sessions SET state = 'paused', state_changed_at = ?2, updated_at = ?2 \
         WHERE current_terminal_id = ?1 AND state = 'crashed'",
        params![terminal_id, now],
    )?;
    Ok(n)
}

/// The terminal row is still open (`closed_at` not set).
pub fn is_open(conn: &Connection, terminal_id: &str) -> AppResult<bool> {
    let open: Option<bool> = conn
        .query_row(
            "SELECT closed_at IS NULL FROM terminals WHERE id = ?1",
            [terminal_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(open.unwrap_or(false))
}

/// Folder a terminal ran in.
pub fn cwd_of(conn: &Connection, terminal_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT cwd FROM terminals WHERE id = ?1",
            [terminal_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// The task of an open Claude terminal: the current task of the app's MCP tools. `None` for
/// another kind of terminal, a closed one or an unknown id.
pub fn claude_task_of(conn: &Connection, terminal_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT task_id FROM terminals \
             WHERE id = ?1 AND kind = 'claude' AND closed_at IS NULL",
            [terminal_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Records a raw hook payload (diagnostics).
pub fn log_hook_event(
    conn: &Connection,
    terminal_id: Option<&str>,
    event: &str,
    payload: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO hook_events (received_at, terminal_id, event, payload) VALUES (?1, ?2, ?3, ?4)",
        params![now_utc(), terminal_id, event, payload],
    )?;
    Ok(())
}

/// The last `limit` hook events, newest first (diagnostic panel).
pub fn hook_events(conn: &Connection, limit: u32) -> AppResult<Vec<HookEventLog>> {
    let limit = i64::from(limit).min(HOOK_EVENTS_MAX_ROWS);
    let mut stmt = conn.prepare(
        "SELECT id, received_at, terminal_id, event, payload FROM hook_events \
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        let id: i64 = r.get(0)?;
        Ok(HookEventLog {
            id: u32::try_from(id).unwrap_or(u32::MAX),
            received_at: r.get(1)?,
            terminal_id: r.get(2)?,
            event: r.get(3)?,
            payload: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Keeps the hook events of the last 7 days, 10,000 at most. Returns the number deleted.
pub fn purge_hook_events(
    conn: &Connection,
    now: chrono::DateTime<chrono::Utc>,
) -> AppResult<usize> {
    let cutoff = (now - chrono::Duration::days(HOOK_EVENTS_MAX_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let old = conn.execute("DELETE FROM hook_events WHERE received_at < ?1", [cutoff])?;
    let extra = conn.execute(
        "DELETE FROM hook_events WHERE id <= \
         (SELECT id FROM hook_events ORDER BY id DESC LIMIT 1 OFFSET ?1)",
        [HOOK_EVENTS_MAX_ROWS],
    )?;
    Ok(old + extra)
}

/// Stores the folder chosen for a task's terminals at the right level:
/// - task with an override, or without project: the task's override;
/// - project without folder, or folder inherited from the project: the project's folder
///   (a sub-project using its parent's folder gets its own);
/// - folder inherited from the section: the section's sub-folder when the path lies inside
///   the project folder (its parent's for a sub-project without folder), else the task's
///   override.
pub fn set_task_folder(conn: &Connection, input: &SetTaskFolderInput) -> AppResult<()> {
    let path = input.path.trim();
    if !Path::new(path).is_absolute() {
        return Err(AppError::Invalid(format!(
            "folder must be an absolute path: {path}"
        )));
    }
    if !Path::new(path).is_dir() {
        return Err(AppError::NotFound(format!("folder {path}")));
    }
    let task = tasks::load(conn, &input.task_id)?;
    // A subtask without its own folder works in its parent's: choose it there.
    if let (Some(parent), None) = (&task.parent_id, &task.workdir_override) {
        return set_task_folder(
            conn,
            &SetTaskFolderInput {
                task_id: parent.clone(),
                path: path.to_string(),
            },
        );
    }
    let detail = tasks::detail(conn, &input.task_id)?;
    let source = detail.workdir.as_ref().map(|w| w.source);
    let now = now_utc();
    let set_override = |p: &str| -> AppResult<()> {
        conn.execute(
            "UPDATE tasks SET workdir_override = ?2, updated_at = ?3 WHERE id = ?1",
            params![task.id, p, now],
        )?;
        Ok(())
    };
    match (&task.subject_id, source) {
        (None, _) | (_, Some(WorkdirSource::Task)) => set_override(path)?,
        (Some(subject_id), Some(WorkdirSource::Section)) => {
            // The sub-folder is relative to the folder the section inherits from.
            let subject = subjects::get(conn, subject_id)?;
            let root = subjects::effective_root(conn, &subject)?.unwrap_or_default();
            let section_id = task.section_id.as_deref().unwrap_or_default();
            match relative_inside(&root, path) {
                Some(sub) => {
                    let sub = sections::validate_subpath(&sub)?;
                    conn.execute(
                        "UPDATE sections SET subpath = ?2, updated_at = ?3 WHERE id = ?1",
                        params![section_id, sub, now],
                    )?;
                }
                None => set_override(path)?,
            }
        }
        (Some(subject_id), _) => {
            conn.execute(
                "UPDATE subjects SET root_path = ?2, updated_at = ?3 WHERE id = ?1",
                params![subject_id, path, now],
            )?;
        }
    }
    Ok(())
}

/// `path` relative to `root` when strictly inside it (no `..`), else `None`.
fn relative_inside(root: &str, path: &str) -> Option<String> {
    if root.is_empty() {
        return None;
    }
    // Windows: without regard to case nor to the slash (`crate::paths`).
    let rel = crate::paths::relative(path, root)?;
    let parts = Path::new(&rel);
    if rel.is_empty()
        || !parts
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return None;
    }
    Some(rel)
}

#[cfg(test)]
mod tests;
