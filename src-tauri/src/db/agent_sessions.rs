//! Claude sessions (`agent_sessions`): the state columns read and written by
//! the state machine, bulk loading for the ring derivation, and the panel's `SessionView`s.
//! Rows are created with their terminal (`db::terminals::insert`).

use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult};
use crate::model::{Agent, ContextUsage, SessionState, SessionView, WaitingKind};
use crate::state::derive::SessionFacts;
use crate::state::machine::{PendingPermission, Session};

/// A session row: its identity and what the state machine knows.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRow {
    pub id: String,
    pub task_id: String,
    pub current_terminal_id: Option<String>,
    /// The tool running the conversation (unknown values read as Claude).
    pub agent: Agent,
    pub session: Session,
}

/// Prefix of a conversation id not known yet: Codex announces its own in its first
/// `SessionStart`.
pub const PENDING_PREFIX: &str = "pending:";

pub fn is_pending_conversation(id: &str) -> bool {
    id.starts_with(PENDING_PREFIX)
}

/// The session row following `conversation_id`, if any.
pub fn conversation_owner(conn: &Connection, conversation_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM agent_sessions WHERE conversation_id = ?1",
            [conversation_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// The agent announced its conversation id: it replaces the provisional one.
pub fn adopt_conversation(conn: &Connection, id: &str, conversation_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE agent_sessions SET conversation_id = ?2 WHERE id = ?1",
        params![id, conversation_id],
    )?;
    Ok(())
}

const COLUMNS: &str = "id, task_id, current_terminal_id, conversation_id, state, waiting_kind, \
    activity, last_message, pending_permission, error_kind, ended_cleanly, state_changed_at, \
    question, agent";

/// Unknown values (hand-edited database) read as Paused rather than failing.
fn parse_state(s: &str) -> SessionState {
    SessionState::parse(s).unwrap_or(SessionState::Paused)
}

fn parse_pending(json: Option<String>) -> Option<PendingPermission> {
    serde_json::from_str(&json?).ok()
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<SessionRow> {
    let waiting_kind: Option<String> = r.get(5)?;
    Ok(SessionRow {
        id: r.get(0)?,
        task_id: r.get(1)?,
        current_terminal_id: r.get(2)?,
        agent: Agent::parse(&r.get::<_, String>(13)?).unwrap_or_default(),
        session: Session {
            conversation_id: r.get(3)?,
            state: parse_state(&r.get::<_, String>(4)?),
            waiting_kind: waiting_kind.as_deref().and_then(WaitingKind::parse),
            activity: r.get(6)?,
            last_message: r.get(7)?,
            pending_permission: parse_pending(r.get(8)?),
            error_kind: r.get(9)?,
            ended_cleanly: r.get(10)?,
            state_changed_at: r.get(11)?,
            question: r.get(12)?,
        },
    })
}

/// The session a terminal currently runs.
pub fn by_terminal(conn: &Connection, terminal_id: &str) -> AppResult<Option<SessionRow>> {
    let sql = format!("SELECT {COLUMNS} FROM agent_sessions WHERE current_terminal_id = ?1");
    Ok(conn.query_row(&sql, [terminal_id], from_row).optional()?)
}

/// Sessions not ended whose terminal is still open.
pub fn with_open_terminal(conn: &Connection) -> AppResult<Vec<SessionRow>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM agent_sessions WHERE ended_at IS NULL AND current_terminal_id IN \
         (SELECT id FROM terminals WHERE closed_at IS NULL)"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<SessionRow> {
    let sql = format!("SELECT {COLUMNS} FROM agent_sessions WHERE id = ?1");
    conn.query_row(&sql, [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("agent session {id}")))
}

/// Writes the state columns of a session (one statement: atomic).
pub fn save(conn: &Connection, id: &str, s: &Session, now: &str) -> AppResult<()> {
    let pending = match &s.pending_permission {
        Some(p) => Some(serde_json::to_string(p).map_err(|e| AppError::Internal(e.to_string()))?),
        None => None,
    };
    conn.execute(
        "UPDATE agent_sessions SET state = ?2, waiting_kind = ?3, activity = ?4, \
         last_message = ?5, pending_permission = ?6, error_kind = ?7, ended_cleanly = ?8, \
         state_changed_at = ?9, updated_at = ?10, question = ?11 WHERE id = ?1",
        params![
            id,
            s.state.as_str(),
            s.waiting_kind.map(WaitingKind::as_str),
            s.activity,
            s.last_message,
            pending,
            s.error_kind,
            s.ended_cleanly,
            s.state_changed_at,
            now,
            s.question
        ],
    )?;
    // Taido V2.1: the task's chrono follows its sessions.
    let task_id: Option<String> = conn
        .query_row(
            "SELECT task_id FROM agent_sessions WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(task_id) = task_id {
        crate::db::time_segments::reconcile(conn, &task_id, now)?;
    }
    Ok(())
}

/// Sessions of the tasks matching `task_where` (a condition on `tasks t`), grouped by task:
/// one query for a whole list view.
pub fn facts_where(
    conn: &Connection,
    task_where: &str,
    params: Vec<Value>,
) -> AppResult<HashMap<String, Vec<SessionFacts>>> {
    let sql = format!(
        "SELECT s.task_id, s.state, s.waiting_kind, \
         (tm.id IS NOT NULL AND tm.closed_at IS NULL), s.activity, s.last_message, \
         s.pending_permission, s.error_kind, s.state_changed_at, s.updated_at, s.started_at, \
         s.question, s.agent \
         FROM agent_sessions s JOIN tasks t ON t.id = s.task_id \
         LEFT JOIN terminals tm ON tm.id = s.current_terminal_id \
         WHERE {task_where}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params), |r| {
        let waiting_kind: Option<String> = r.get(2)?;
        let facts = SessionFacts {
            agent: Agent::parse(&r.get::<_, String>(12)?).unwrap_or_default(),
            state: parse_state(&r.get::<_, String>(1)?),
            waiting_kind: waiting_kind.as_deref().and_then(WaitingKind::parse),
            terminal_open: r.get(3)?,
            activity: r.get(4)?,
            last_message: r.get(5)?,
            permission: parse_pending(r.get(6)?).map(|p| p.summary),
            error_kind: r.get(7)?,
            state_changed_at: r.get(8)?,
            updated_at: r.get(9)?,
            started_at: r.get(10)?,
            question: r.get(11)?,
        };
        Ok((r.get::<_, String>(0)?, facts))
    })?;
    let mut by_task: HashMap<String, Vec<SessionFacts>> = HashMap::new();
    for row in rows {
        let (task_id, facts) = row?;
        by_task.entry(task_id).or_default().push(facts);
    }
    Ok(by_task)
}

/// Sessions of one task (its own only).
#[cfg(test)]
pub fn facts_for_task(conn: &Connection, task_id: &str) -> AppResult<Vec<SessionFacts>> {
    let mut by_task = facts_where(conn, "t.id = ?", vec![Value::Text(task_id.to_string())])?;
    Ok(by_task.remove(task_id).unwrap_or_default())
}

/// The panel's view of the given sessions, in the given order (unknown ids are skipped).
pub fn views(conn: &Connection, ids: &[String]) -> AppResult<Vec<SessionView>> {
    let mut views = Vec::with_capacity(ids.len());
    for id in ids {
        let row = match get(conn, id) {
            Ok(row) => row,
            Err(AppError::NotFound(_)) => continue,
            Err(e) => return Err(e),
        };
        let open: bool = match &row.current_terminal_id {
            Some(t) => conn
                .query_row(
                    "SELECT closed_at IS NULL FROM terminals WHERE id = ?1",
                    [t],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(false),
            None => false,
        };
        views.push(view(&row, open, context_usage(conn, id)?));
    }
    Ok(views)
}

/// Each field is set only in the state that shows it.
fn view(row: &SessionRow, terminal_open: bool, context: Option<ContextUsage>) -> SessionView {
    let s = &row.session;
    let waiting = |kind| s.state == SessionState::Waiting && s.waiting_kind == Some(kind);
    SessionView {
        id: row.id.clone(),
        agent: row.agent,
        terminal_id: row.current_terminal_id.clone().filter(|_| terminal_open),
        state: s.state,
        waiting_kind: s.waiting_kind.filter(|_| s.state == SessionState::Waiting),
        activity: s
            .activity
            .clone()
            .filter(|_| s.state == SessionState::Working),
        question: s
            .question
            .clone()
            .filter(|_| waiting(WaitingKind::Question)),
        permission: if waiting(WaitingKind::Permission) {
            s.pending_permission.as_ref().map(|p| p.summary.clone())
        } else {
            None
        },
        permissions_more: 0,
        error_kind: s
            .error_kind
            .clone()
            .filter(|_| s.state == SessionState::Error),
        last_message: s
            .last_message
            .clone()
            .filter(|_| s.state == SessionState::Done),
        since: s.state_changed_at.clone(),
        context,
    }
}

/// The last context usage recorded for the session (unreadable JSON reads as unknown).
pub fn context_usage(conn: &Connection, id: &str) -> AppResult<Option<ContextUsage>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT context_usage FROM agent_sessions WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

/// Records the session's context usage (`None` forgets it: after a compaction). Returns
/// whether it changed.
pub fn set_context_usage(
    conn: &Connection,
    id: &str,
    usage: Option<&ContextUsage>,
) -> AppResult<bool> {
    // Serialising plain numbers and strings cannot fail.
    let json = usage.and_then(|u| serde_json::to_string(u).ok());
    let changed = conn.execute(
        "UPDATE agent_sessions SET context_usage = ?2 WHERE id = ?1 AND context_usage IS NOT ?2",
        params![id, json],
    )?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests;

/// Result of a conversation change in a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Switched {
    /// The row now attached to the terminal.
    pub session_id: String,
    /// The conversation was already known (a `/resume` from inside Claude): reattached.
    pub reattached: bool,
    /// Task the reattached conversation belonged to before.
    pub previous_task_id: Option<String>,
}

/// A terminal moved to another conversation (`/clear`, fork, `/resume` typed in Claude): the current session ends (history, `current_terminal_id` cleared), then the
/// known row of `conversation_id` is reattached to the terminal, or a new row is created
/// (it inherits the mode and the context choice, and the task). The attached one is Idle.
/// Call inside a transaction.
pub fn switch_conversation(
    conn: &Connection,
    current: &SessionRow,
    conversation_id: &str,
    terminal_id: &str,
    now: &str,
) -> AppResult<Switched> {
    conn.execute(
        "UPDATE agent_sessions SET state = 'paused', current_terminal_id = NULL, \
         waiting_kind = NULL, pending_permission = NULL, question = NULL, \
         ended_at = COALESCE(ended_at, ?2), state_changed_at = ?2, updated_at = ?2 \
         WHERE id = ?1",
        params![current.id, now],
    )?;
    let known: Option<(String, String)> = conn
        .query_row(
            "SELECT id, task_id FROM agent_sessions WHERE conversation_id = ?1",
            [conversation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let switched = match known {
        Some((id, previous_task_id)) => {
            conn.execute(
                "UPDATE agent_sessions SET task_id = ?2, current_terminal_id = ?3, \
                 state = 'idle', waiting_kind = NULL, activity = NULL, pending_permission = NULL, \
                 question = NULL, error_kind = NULL, ended_cleanly = 0, ended_at = NULL, \
                 state_changed_at = ?4, updated_at = ?4 WHERE id = ?1",
                params![id, current.task_id, terminal_id, now],
            )?;
            Switched {
                session_id: id,
                reattached: true,
                previous_task_id: Some(previous_task_id),
            }
        }
        None => {
            let id = crate::db::new_id();
            conn.execute(
                "INSERT INTO agent_sessions (id, task_id, conversation_id, current_terminal_id, \
                 state, permission_mode, add_task_context, state_changed_at, started_at, \
                 updated_at, agent) \
                 SELECT ?1, task_id, ?2, ?3, 'idle', permission_mode, add_task_context, ?4, ?4, ?4, \
                 agent \
                 FROM agent_sessions WHERE id = ?5",
                params![id, conversation_id, terminal_id, now, current.id],
            )?;
            Switched {
                session_id: id,
                reattached: false,
                previous_task_id: None,
            }
        }
    };
    Ok(switched)
}

/// Mode and context choice a session was launched with, passed again on resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchOptions {
    pub permission_mode: Option<crate::model::PermissionMode>,
    pub add_task_context: bool,
}

pub fn launch_options(conn: &Connection, id: &str) -> AppResult<LaunchOptions> {
    let (mode, context): (Option<String>, bool) = conn
        .query_row(
            "SELECT permission_mode, add_task_context FROM agent_sessions WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("agent session {id}")))?;
    Ok(LaunchOptions {
        permission_mode: mode
            .as_deref()
            .and_then(crate::model::PermissionMode::parse),
        add_task_context: context,
    })
}

/// What `attach_resumed` replaced, to undo it when the process cannot start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeforeResume {
    pub id: String,
    pub terminal_id: Option<String>,
    pub task_id: String,
    pub state: String,
    pub ended_cleanly: bool,
    pub ended_at: Option<String>,
    pub state_changed_at: String,
}

/// « Reprendre »: the session runs again, in `terminal_id` (Starting, not ended). The task
/// follows the terminal (a conversation reattached from another task moves with it).
/// Returns what it replaced.
pub fn attach_resumed(
    conn: &Connection,
    id: &str,
    terminal_id: &str,
    task_id: &str,
    now: &str,
) -> AppResult<BeforeResume> {
    let before = conn
        .query_row(
            "SELECT current_terminal_id, task_id, state, ended_cleanly, ended_at, \
             state_changed_at FROM agent_sessions WHERE id = ?1",
            [id],
            |r| {
                Ok(BeforeResume {
                    id: id.to_string(),
                    terminal_id: r.get(0)?,
                    task_id: r.get(1)?,
                    state: r.get(2)?,
                    ended_cleanly: r.get(3)?,
                    ended_at: r.get(4)?,
                    state_changed_at: r.get(5)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("agent session {id}")))?;
    conn.execute(
        "UPDATE agent_sessions SET current_terminal_id = ?2, task_id = ?3, state = 'starting', \
         waiting_kind = NULL, activity = NULL, pending_permission = NULL, question = NULL, \
         error_kind = NULL, ended_cleanly = 0, ended_at = NULL, state_changed_at = ?4, \
         updated_at = ?4 WHERE id = ?1",
        params![id, terminal_id, task_id, now],
    )?;
    Ok(before)
}

/// The resumed process could not start: the session gets back exactly what it had (its
/// terminal, flags and dates: a clean session must not read as crashed), and the new
/// terminal row is removed.
pub fn detach_failed_resume(
    conn: &Connection,
    terminal_id: &str,
    before: &BeforeResume,
) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE agent_sessions SET current_terminal_id = ?2, task_id = ?3, state = ?4, \
         ended_cleanly = ?5, ended_at = ?6, state_changed_at = ?7, updated_at = ?7 \
         WHERE id = ?1",
        params![
            before.id,
            before.terminal_id,
            before.task_id,
            before.state,
            before.ended_cleanly,
            before.ended_at,
            before.state_changed_at
        ],
    )?;
    tx.execute("DELETE FROM terminals WHERE id = ?1", [terminal_id])?;
    tx.commit()?;
    Ok(())
}
