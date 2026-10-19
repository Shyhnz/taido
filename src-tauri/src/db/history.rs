//! History of a task's Claude sessions: the « Sessions Claude » list and the
//! trace of each session (its `journal_entries` rows with an `agent_session_id`).

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult};
use crate::model::{Agent, Exchange, ExchangeKind, SessionState, SessionSummary};
use crate::state::summary;

/// Characters of the first prompt shown in the list.
const FIRST_PROMPT_MAX_CHARS: usize = 200;

/// Messages the user typed in a session (prompts in its trace).
pub fn prompt_count(conn: &Connection, agent_session_id: &str) -> AppResult<u32> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM journal_entries WHERE agent_session_id = ?1 AND kind = 'prompt'",
        [agent_session_id],
        |r| r.get(0),
    )?)
}

/// Sessions of a task, newest first. `terminal_id` and `resumable` need the tabs the PTY
/// manager keeps: `running_terminal` tells whether a terminal id is a running tab.
///
/// A conversation without any message is hidden, unless it runs
/// in a tab (Claude keeps nothing of it, there is nothing to come back to).
pub fn sessions_of_task(
    conn: &Connection,
    task_id: &str,
    running_terminal: impl Fn(&str) -> bool,
) -> AppResult<Vec<SessionSummary>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.state, s.current_terminal_id, s.started_at, s.ended_at, s.ended_cleanly, \
         COALESCE(t.closed_by_user, 0), \
         (SELECT text FROM journal_entries j WHERE j.agent_session_id = s.id \
            AND j.kind = 'prompt' ORDER BY j.at, j.rowid LIMIT 1), \
         (SELECT COUNT(*) FROM journal_entries j WHERE j.agent_session_id = s.id \
            AND j.kind = 'prompt'), \
         (SELECT text FROM journal_entries j WHERE j.agent_session_id = s.id \
            AND j.kind = 'turn_ended' ORDER BY j.at DESC, j.rowid DESC LIMIT 1), \
         s.title, s.ai_summary, s.agent \
         FROM agent_sessions s LEFT JOIN terminals t ON t.id = s.current_terminal_id \
         WHERE s.task_id = ?1 ORDER BY s.started_at DESC, s.id DESC",
    )?;
    let rows = stmt.query_map([task_id], |r| row_to_summary(r, &running_terminal))?;
    let mut sessions = Vec::new();
    for row in rows {
        let summary = row?;
        if summary.prompt_count > 0 || summary.terminal_id.is_some() {
            sessions.push(summary);
        }
    }
    Ok(sessions)
}

fn row_to_summary(
    r: &Row<'_>,
    running_terminal: &impl Fn(&str) -> bool,
) -> rusqlite::Result<SessionSummary> {
    let state = SessionState::parse(&r.get::<_, String>(1)?).unwrap_or(SessionState::Paused);
    let terminal: Option<String> = r.get(2)?;
    let ended_at: Option<String> = r.get(4)?;
    let ended_cleanly: bool = r.get(5)?;
    let closed_by_user: bool = r.get(6)?;
    let first_prompt: Option<String> = r.get(7)?;
    let prompt_count: u32 = r.get(8)?;
    let last_reply: Option<String> = r.get(9)?;
    let terminal_id = terminal.filter(|t| running_terminal(t));
    // Died without SessionEnd and not closed by the user: kept as history, flagged.
    let crashed = state == SessionState::Crashed
        || (terminal_id.is_none() && ended_at.is_some() && !ended_cleanly && !closed_by_user);
    Ok(SessionSummary {
        id: r.get(0)?,
        agent: Agent::parse(&r.get::<_, String>(12)?).unwrap_or_default(),
        state,
        resumable: terminal_id.is_none() && prompt_count > 0,
        terminal_id,
        started_at: r.get(3)?,
        ended_at,
        first_prompt: first_prompt.map(|p| p.chars().take(FIRST_PROMPT_MAX_CHARS).collect()),
        prompt_count,
        crashed,
        last_reply: last_reply.as_deref().and_then(summary::reply_text),
        title: r.get(10)?,
        ai_summary: r.get(11)?,
    })
}

/// Characters kept of a title or an AI recap.
pub const TITLE_MAX_CHARS: usize = 120;

/// Renames a session; an empty title goes back to the automatic recap.
pub fn rename(conn: &Connection, agent_session_id: &str, title: &str) -> AppResult<String> {
    let title: String = title.trim().chars().take(TITLE_MAX_CHARS).collect();
    let task_id: Option<String> = conn
        .query_row(
            "SELECT task_id FROM agent_sessions WHERE id = ?1",
            [agent_session_id],
            |r| r.get(0),
        )
        .optional()?;
    let task_id =
        task_id.ok_or_else(|| AppError::NotFound(format!("agent session {agent_session_id}")))?;
    let value = (!title.is_empty()).then_some(title);
    conn.execute(
        "UPDATE agent_sessions SET title = ?2 WHERE id = ?1",
        params![agent_session_id, value],
    )?;
    Ok(task_id)
}

/// Ended sessions with at least one message and neither recap nor title yet: what the
/// summarizer still has to do, oldest first.
pub fn sessions_to_summarize(conn: &Connection, task_id: Option<&str>) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT s.id FROM agent_sessions s WHERE s.ended_at IS NOT NULL \
         AND s.ai_summary IS NULL AND (?1 IS NULL OR s.task_id = ?1) \
         AND EXISTS (SELECT 1 FROM journal_entries j WHERE j.agent_session_id = s.id \
                     AND j.kind = 'prompt') \
         ORDER BY s.ended_at",
    )?;
    let rows = stmt.query_map(params![task_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Stores the recap Haiku wrote; returns the session's task.
pub fn set_ai_summary(conn: &Connection, agent_session_id: &str, text: &str) -> AppResult<String> {
    let text: String = text.trim().chars().take(TITLE_MAX_CHARS).collect();
    conn.execute(
        "UPDATE agent_sessions SET ai_summary = ?2 WHERE id = ?1",
        params![agent_session_id, text],
    )?;
    Ok(conn.query_row(
        "SELECT task_id FROM agent_sessions WHERE id = ?1",
        [agent_session_id],
        |r| r.get(0),
    )?)
}

/// The trace of a session, oldest first.
pub fn exchanges(conn: &Connection, agent_session_id: &str) -> AppResult<Vec<Exchange>> {
    let mut stmt = conn.prepare(
        "SELECT kind, text, at FROM journal_entries WHERE agent_session_id = ?1 \
         AND kind IN ('prompt', 'turn_ended', 'error', 'resumed', 'cleared', 'compacted') \
         ORDER BY at, rowid",
    )?;
    let rows = stmt.query_map(params![agent_session_id], |r| {
        let kind = match r.get::<_, String>(0)?.as_str() {
            "prompt" => ExchangeKind::Prompt,
            "turn_ended" => ExchangeKind::Reply,
            "error" => ExchangeKind::Error,
            "resumed" => ExchangeKind::Resumed,
            "cleared" => ExchangeKind::Cleared,
            _ => ExchangeKind::Compacted,
        };
        Ok(Exchange {
            kind,
            text: r.get(1)?,
            at: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests;
