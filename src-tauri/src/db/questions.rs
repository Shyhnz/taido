//! Questions asked to a project (« Demander au projet »):
//! kept like the conversations of the tasks, on this computer only (never synced).

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::ask::{AskEntry, AskThread, Source};
use crate::db::{new_id, now_utc};
use crate::error::{AppError, AppResult};
use crate::model::Agent;

/// Threads listed at most in the panel.
pub const MAX_THREADS: usize = 50;

/// A stored question, as the search reads it.
pub struct Stored {
    pub id: String,
    pub question: String,
    pub answer: String,
    pub asked_at: String,
}

fn entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<AskEntry> {
    let sources: String = r.get(6)?;
    Ok(AskEntry {
        id: r.get(0)?,
        thread_id: r.get(1)?,
        agent: Agent::parse(&r.get::<_, String>(2)?).unwrap_or_default(),
        question: r.get(3)?,
        answer: r.get(4)?,
        asked_at: r.get(5)?,
        sources: serde_json::from_str::<Vec<Source>>(&sources).unwrap_or_default(),
    })
}

const COLUMNS: &str = "id, thread_id, agent, question, answer, asked_at, sources";

pub fn insert(
    conn: &Connection,
    subject_id: &str,
    thread_id: &str,
    agent: Agent,
    question: &str,
    answer: &str,
    sources: &[Source],
) -> AppResult<AskEntry> {
    let id = new_id();
    let json =
        serde_json::to_string(sources).map_err(|e| AppError::Internal(format!("sources: {e}")))?;
    conn.execute(
        "INSERT INTO project_questions (id, subject_id, thread_id, agent, question, answer, \
         sources, asked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            subject_id,
            thread_id,
            agent.as_str(),
            question,
            answer,
            json,
            now_utc()
        ],
    )?;
    get(conn, &id)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<AskEntry> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM project_questions WHERE id = ?1"),
        [id],
        entry,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("question {id}")))
}

/// Project of a stored question.
pub fn subject_of(conn: &Connection, id: &str) -> AppResult<String> {
    conn.query_row(
        "SELECT subject_id FROM project_questions WHERE id = ?1",
        [id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("question {id}")))
}

/// The questions of a thread, oldest first.
pub fn thread(conn: &Connection, thread_id: &str) -> AppResult<Vec<AskEntry>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM project_questions WHERE thread_id = ?1 ORDER BY asked_at, rowid"
    ))?;
    let rows = stmt.query_map([thread_id], entry)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Threads of a project, most recent first: its first question, how many, last asked.
pub fn threads(conn: &Connection, subject_id: &str) -> AppResult<Vec<AskThread>> {
    let mut stmt = conn.prepare(
        "SELECT thread_id, \
         (SELECT question FROM project_questions f WHERE f.thread_id = q.thread_id \
          ORDER BY asked_at, rowid LIMIT 1), \
         COUNT(*), MAX(asked_at) FROM project_questions q WHERE subject_id = ?1 \
         GROUP BY thread_id ORDER BY MAX(asked_at) DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![subject_id, MAX_THREADS as i64], |r| {
        Ok(AskThread {
            thread_id: r.get(0)?,
            question: r.get(1)?,
            count: r.get(2)?,
            asked_at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every question of these projects (the conversation search).
pub fn for_subjects(conn: &Connection, subjects: &[String]) -> AppResult<Vec<Stored>> {
    let ids = vec!["?"; subjects.len()].join(", ");
    let mut stmt = conn.prepare(&format!(
        "SELECT id, question, answer, asked_at FROM project_questions \
         WHERE subject_id IN ({ids})"
    ))?;
    let rows = stmt.query_map(params_from_iter(subjects), |r| {
        Ok(Stored {
            id: r.get(0)?,
            question: r.get(1)?,
            answer: r.get(2)?,
            asked_at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
