//! Task journal: creation, completion, reopening and notes.

use rusqlite::{params, Connection, Row};

use crate::db::{new_id, non_empty, now_utc, tasks};
use crate::error::{AppError, AppResult};
use crate::model::{AddNoteInput, Agent, JournalEntry, JournalKind};

/// Appends an entry; `text` is empty for the kinds the UI labels itself.
pub fn add(
    conn: &Connection,
    task_id: &str,
    kind: JournalKind,
    text: &str,
) -> AppResult<JournalEntry> {
    let entry = JournalEntry {
        id: new_id(),
        task_id: task_id.to_string(),
        agent_session_id: None,
        agent: None,
        kind,
        text: text.to_string(),
        at: now_utc(),
    };
    conn.execute(
        "INSERT INTO journal_entries (id, task_id, agent_session_id, kind, text, at) \
         VALUES (?1, ?2, NULL, ?3, ?4, ?5)",
        params![entry.id, entry.task_id, kind.as_str(), entry.text, entry.at],
    )?;
    Ok(entry)
}

/// Characters kept of a prompt or a reply in the session trace.
pub const EXCHANGE_MAX_CHARS: usize = 2000;

/// Appends an entry of a Claude session (its trace), text truncated.
pub fn add_for_session(
    conn: &Connection,
    task_id: &str,
    agent_session_id: &str,
    kind: JournalKind,
    text: &str,
) -> AppResult<()> {
    let text: String = text.chars().take(EXCHANGE_MAX_CHARS).collect();
    conn.execute(
        "INSERT INTO journal_entries (id, task_id, agent_session_id, kind, text, at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            new_id(),
            task_id,
            agent_session_id,
            kind.as_str(),
            text,
            now_utc()
        ],
    )?;
    Ok(())
}

/// User note: trimmed, non-empty.
pub fn add_note(conn: &Connection, input: &AddNoteInput) -> AppResult<JournalEntry> {
    let text = non_empty(&input.text, "note")?;
    tasks::ensure_exists(conn, &input.task_id)?;
    add(conn, &input.task_id, JournalKind::Note, &text)
}

/// Entries of a task, most recent first.
pub fn list(conn: &Connection, task_id: &str) -> AppResult<Vec<JournalEntry>> {
    tasks::ensure_exists(conn, task_id)?;
    let mut stmt = conn.prepare(
        "SELECT j.id, j.task_id, j.agent_session_id, j.kind, j.text, j.at, s.agent \
         FROM journal_entries j LEFT JOIN agent_sessions s ON s.id = j.agent_session_id \
         WHERE j.task_id = ?1 ORDER BY j.at DESC, j.rowid DESC",
    )?;
    let rows = stmt.query_map([task_id], from_row)?;
    let raw: Vec<(JournalEntry, String)> = rows.collect::<Result<_, _>>()?;
    raw.into_iter()
        .map(|(mut entry, kind)| {
            entry.kind = JournalKind::parse(&kind)
                .ok_or_else(|| AppError::Internal(format!("unknown journal kind {kind}")))?;
            Ok(entry)
        })
        .collect()
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<(JournalEntry, String)> {
    Ok((
        JournalEntry {
            id: r.get(0)?,
            task_id: r.get(1)?,
            agent_session_id: r.get(2)?,
            agent: r
                .get::<_, Option<String>>(6)?
                .as_deref()
                .map(|a| Agent::parse(a).unwrap_or_default()),
            kind: JournalKind::Note,
            text: r.get(4)?,
            at: r.get(5)?,
        },
        r.get(3)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::test_support::task;
    use crate::model::SetCompletedInput;

    fn kinds(conn: &Connection, id: &str) -> Vec<JournalKind> {
        list(conn, id)
            .expect("list")
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }

    fn set_completed(conn: &Connection, id: &str, completed: bool) {
        tasks::set_completed(
            conn,
            &SetCompletedInput {
                id: id.into(),
                completed,
            },
        )
        .expect("set_completed");
    }

    #[test]
    fn created_complete_reopen_only_on_change() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        assert_eq!(kinds(&conn, &id), vec![JournalKind::Created]);
        set_completed(&conn, &id, true);
        set_completed(&conn, &id, true);
        assert_eq!(
            kinds(&conn, &id),
            vec![JournalKind::Completed, JournalKind::Created]
        );
        set_completed(&conn, &id, false);
        set_completed(&conn, &id, false);
        assert_eq!(
            kinds(&conn, &id),
            vec![
                JournalKind::Reopened,
                JournalKind::Completed,
                JournalKind::Created
            ]
        );
        let entries = list(&conn, &id).expect("list");
        assert!(entries.iter().all(|e| e.text.is_empty()));
        assert!(entries.iter().all(|e| e.at.ends_with('Z')));
    }

    #[test]
    fn notes() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        let note = add_note(
            &conn,
            &AddNoteInput {
                task_id: id.clone(),
                text: "  hello  ".into(),
            },
        )
        .expect("note");
        assert_eq!(note.text, "hello");
        assert_eq!(note.kind, JournalKind::Note);
        let first = &list(&conn, &id).expect("list")[0];
        assert_eq!(first, &note);
        let empty = add_note(
            &conn,
            &AddNoteInput {
                task_id: id.clone(),
                text: " \n ".into(),
            },
        );
        assert!(matches!(empty, Err(AppError::Invalid(_))));
        let missing = add_note(
            &conn,
            &AddNoteInput {
                task_id: "nope".into(),
                text: "x".into(),
            },
        );
        assert!(matches!(missing, Err(AppError::NotFound(_))));
        assert!(matches!(list(&conn, "nope"), Err(AppError::NotFound(_))));
    }

    #[test]
    fn session_entries_name_their_agent() {
        let conn = open_in_memory().expect("db");
        let t = task(&conn, "Export", None, None);
        crate::db::test_support::codex_terminal(&conn, &t, "term", "sess", "019a");
        add_for_session(&conn, &t, "sess", JournalKind::TurnEnded, "OK").expect("entry");
        let entries = list(&conn, &t).expect("list");
        let turn = entries
            .iter()
            .find(|e| e.kind == JournalKind::TurnEnded)
            .expect("turn");
        assert_eq!(turn.agent, Some(crate::model::Agent::Codex));
        let created = entries
            .iter()
            .find(|e| e.kind == JournalKind::Created)
            .expect("created");
        assert_eq!(created.agent, None);
    }
}
