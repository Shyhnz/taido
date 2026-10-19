//! Fixtures shared by the tests.

use rusqlite::Connection;

use crate::db::{sections, subjects, tasks, terminals};
use crate::model::{
    CreateSectionInput, CreateSubjectInput, CreateTaskInput, SubjectColor, TerminalKind,
};

/// Creates a subject rooted at `/tmp/<name>` and returns its id.
pub fn subject(conn: &Connection, name: &str) -> String {
    subjects::create(
        conn,
        &CreateSubjectInput {
            name: name.into(),
            color: Some(SubjectColor::Violet),
            root_path: Some(format!("/tmp/{name}")),
            parent_id: None,
        },
    )
    .expect("create subject")
    .id
}

/// Creates a sub-project of `parent_id` with an optional folder and
/// returns its id.
pub fn sub_project(conn: &Connection, parent_id: &str, name: &str, root: Option<&str>) -> String {
    // Taido V2.2 bis: only a group holds projects.
    conn.execute(
        "UPDATE subjects SET is_group = 1 WHERE id = ?1",
        [parent_id],
    )
    .expect("make the parent a group");
    subjects::create(
        conn,
        &CreateSubjectInput {
            name: name.into(),
            color: Some(SubjectColor::Teal),
            root_path: root.map(String::from),
            parent_id: Some(parent_id.into()),
        },
    )
    .expect("create sub-project")
    .id
}

pub fn section(conn: &Connection, subject_id: &str, name: &str) -> String {
    sections::create(
        conn,
        &CreateSectionInput {
            subject_id: subject_id.into(),
            name: name.into(),
            subpath: None,
        },
    )
    .expect("create section")
    .id
}

pub fn task(
    conn: &Connection,
    title: &str,
    subject_id: Option<&str>,
    section_id: Option<&str>,
) -> String {
    tasks::create(
        conn,
        &CreateTaskInput {
            title: title.into(),
            description: None,
            subject_id: subject_id.map(String::from),
            section_id: section_id.map(String::from),
            due_date: None,
            due_time: None,
        },
    )
    .expect("create task")
    .id
}

/// Opens a Claude terminal `terminal_id` on a task, with its session `session_id` (Starting)
/// following the conversation `conversation_id`.
pub fn claude_terminal(
    conn: &Connection,
    task_id: &str,
    terminal_id: &str,
    session_id: &str,
    conversation_id: &str,
) {
    let at = crate::db::now_utc();
    terminals::insert(
        conn,
        &terminals::NewTerminal {
            id: terminal_id,
            task_id,
            kind: TerminalKind::Agent,
            command: None,
            cwd: "/tmp",
            opened_at: &at,
        },
        Some(&terminals::NewSession {
            id: session_id,
            task_id,
            conversation_id,
            agent: crate::model::Agent::Claude,
            terminal_id,
            permission_mode: None,
            add_task_context: true,
            at: &at,
        }),
    )
    .expect("insert claude terminal");
}

/// Opens a Codex terminal `terminal_id` on a task, with its session `session_id` (Starting)
/// following the conversation `conversation_id`.
pub fn codex_terminal(
    conn: &Connection,
    task_id: &str,
    terminal_id: &str,
    session_id: &str,
    conversation_id: &str,
) {
    let at = crate::db::now_utc();
    terminals::insert(
        conn,
        &terminals::NewTerminal {
            id: terminal_id,
            task_id,
            kind: TerminalKind::Agent,
            command: None,
            cwd: "/tmp",
            opened_at: &at,
        },
        Some(&terminals::NewSession {
            id: session_id,
            task_id,
            conversation_id,
            agent: crate::model::Agent::Codex,
            terminal_id,
            permission_mode: None,
            add_task_context: true,
            at: &at,
        }),
    )
    .expect("insert codex terminal");
}

/// Sets a session's state columns directly (`state_changed_at` = `at`).
pub fn set_session_state(
    conn: &Connection,
    session_id: &str,
    state: &str,
    waiting_kind: Option<&str>,
    at: &str,
) {
    conn.execute(
        "UPDATE agent_sessions SET state = ?2, waiting_kind = ?3, state_changed_at = ?4, \
         updated_at = ?4 WHERE id = ?1",
        rusqlite::params![session_id, state, waiting_kind, at],
    )
    .expect("set session state");
}

/// Titles of all tasks of a place (open and completed), by position.
pub fn titles_in(
    conn: &Connection,
    subject_id: Option<&str>,
    section_id: Option<&str>,
) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT title FROM tasks WHERE subject_id IS ?1 AND section_id IS ?2 \
             ORDER BY position, id",
        )
        .expect("prepare");
    let rows = stmt
        .query_map(rusqlite::params![subject_id, section_id], |r| r.get(0))
        .expect("query");
    rows.collect::<Result<_, _>>().expect("rows")
}

/// Moves a soft deletion one minute back, so that a later deletion in the same millisecond
/// cannot share its instant.
pub fn backdate_deletion(conn: &Connection, table: &str, id: &str) {
    conn.execute(
        &format!(
            "UPDATE {table} SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, \
             '-1 minute') WHERE id = ?1"
        ),
        [id],
    )
    .expect("backdate deletion");
}
