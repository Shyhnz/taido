//! Tasks repository.
//!
//! A subtask is a child task (`parent_id`, one level only). It shares its
//! parent's project and section, moves, is deleted and restored with it; completing the
//! parent completes its open children (like Todoist), reopening it leaves them as they are.

use std::path::Path;

use chrono::{NaiveDate, NaiveTime};
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::positions::{self, Scope};
use crate::db::{journal, new_id, non_empty, now_utc, sections, subjects, time_segments, workdir};
use crate::error::{AppError, AppResult};
use crate::model::{
    CreateTaskInput, Due, JournalKind, MoveTaskInput, SectionTag, SetCompletedInput, SetDueInput,
    SetPriorityInput, SetWorkdirOverrideInput, SubjectTag, TaskDetail, TaskRef, UpdateTaskInput,
};
use crate::views::rows::{self, Filter};

/// A row of the `tasks` table.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRecord {
    pub id: String,
    pub subject_id: Option<String>,
    pub section_id: Option<String>,
    /// Set on a child task (a subtask).
    pub parent_id: Option<String>,
    pub title: String,
    pub description: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub workdir_override: Option<String>,
    pub completed_at: Option<String>,
    pub position: f64,
    /// 1 to 4.
    pub priority: u8,
    pub created_at: String,
    pub updated_at: String,
}

impl TaskRecord {
    fn scope(&self) -> Scope<'_> {
        match &self.parent_id {
            Some(parent) => Scope::Subtasks { task_id: parent },
            None => Scope::Tasks {
                subject_id: self.subject_id.as_deref(),
                section_id: self.section_id.as_deref(),
            },
        }
    }
}

const COLUMNS: &str = "id, subject_id, section_id, parent_id, title, description, due_date, \
    due_time, workdir_override, completed_at, position, priority, created_at, updated_at";

/// Lowest and highest priority (by design: 1 is the default look, 4 the red outline).
pub const PRIORITIES: std::ops::RangeInclusive<u8> = 1..=4;

/// A live (not deleted) task.
pub fn load(conn: &Connection, id: &str) -> AppResult<TaskRecord> {
    let sql = format!("SELECT {COLUMNS} FROM tasks WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("task {id}")))
}

/// The task exists and is not deleted.
pub fn ensure_exists(conn: &Connection, id: &str) -> AppResult<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::NotFound(format!("task {id}")))
}

/// Live child tasks of a task, by position.
pub fn child_ids(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY position, id",
    )?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The task and its live children: what closing a task's terminals concerns.
pub fn with_children(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut ids = vec![id.to_string()];
    ids.extend(child_ids(conn, id)?);
    Ok(ids)
}

/// Task panel model, overdue computed against the local date. `git_branch` is left `None`:
/// the caller fills it with [`with_git_branch`] once the database lock is released.
pub fn detail(conn: &Connection, id: &str) -> AppResult<TaskDetail> {
    detail_on(conn, id, chrono::Local::now().date_naive())
}

pub fn detail_on(conn: &Connection, id: &str, today: NaiveDate) -> AppResult<TaskDetail> {
    let t = load(conn, id)?;
    let parent = match &t.parent_id {
        Some(p) => Some(load(conn, p)?),
        None => None,
    };
    let subject = match &t.subject_id {
        Some(s) => Some(subjects::get(conn, s)?),
        None => None,
    };
    let section = match &t.section_id {
        Some(s) => Some(sections::get(conn, s)?),
        None => None,
    };
    // A child works in its parent's folder unless it has its own.
    let workdir_override = t
        .workdir_override
        .as_deref()
        .or(parent.as_ref().and_then(|p| p.workdir_override.as_deref()));
    // A sub-project without folder works in its parent's.
    // Without project: the app's « Sans projet » folder.
    let root = match &subject {
        Some(s) => subjects::effective_root(conn, s)?,
        None => crate::db::workspace::no_project_folder(conn)?,
    };
    let workdir = workdir::resolve(
        workdir_override,
        root.as_deref(),
        section.as_ref().and_then(|s| s.subpath.as_deref()),
    );
    // The ring of a parent sums up its children's sessions.
    let facts = rows::load(conn, Filter::Ids(std::slice::from_ref(&t.id)))?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound(format!("task {id}")))?;
    let (ring, line, ring_since) = facts.detail_line();
    Ok(TaskDetail {
        subject: subject.map(|s| SubjectTag {
            id: s.id,
            name: s.name,
            color: s.color,
        }),
        section: section.map(|s| SectionTag {
            id: s.id,
            name: s.name,
        }),
        due: make_due(t.due_date.as_deref(), t.due_time.as_deref(), today),
        workdir,
        git_branch: None,
        line,
        ring_since,
        ring,
        subtasks: facts
            .children
            .iter()
            .map(|c| c.to_subtask(&t.id, today))
            .collect(),
        id: t.id,
        title: t.title,
        description: t.description,
        workdir_override: t.workdir_override,
        completed_at: t.completed_at,
        created_at: t.created_at,
        updated_at: t.updated_at,
        terminals: Vec::new(),
        sessions: Vec::new(),
        priority: t.priority,
        parent: parent.map(|p| TaskRef {
            id: p.id,
            title: p.title,
        }),
        time: time_segments::task_time(conn, id)?,
        attachments: crate::db::attachments::list(conn, id)?,
        relations: crate::db::relations::of_task(conn, id)?,
    })
}

/// Fills `git_branch` from the resolved working folder (spawns git, ~1 s at most).
pub fn with_git_branch(mut detail: TaskDetail) -> TaskDetail {
    detail.git_branch = detail
        .workdir
        .as_ref()
        .filter(|w| w.exists)
        .and_then(|w| workdir::git_branch(&w.path));
    detail
}

/// Due model; `None` without date.
pub fn make_due(date: Option<&str>, time: Option<&str>, today: NaiveDate) -> Option<Due> {
    let date = date?;
    let overdue = NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok_and(|d| d < today);
    Some(Due {
        date: date.to_string(),
        time: time.map(str::to_string),
        overdue,
    })
}

pub fn create(conn: &Connection, input: &CreateTaskInput) -> AppResult<TaskDetail> {
    let title = non_empty(&input.title, "task title")?;
    validate_place(
        conn,
        input.subject_id.as_deref(),
        input.section_id.as_deref(),
    )?;
    let (due_date, due_time) = validate_due(input.due_date.as_deref(), input.due_time.as_deref())?;
    let description = input.description.clone().unwrap_or_default();
    let id = new_id();
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let position = positions::append(
        &tx,
        Scope::Tasks {
            subject_id: input.subject_id.as_deref(),
            section_id: input.section_id.as_deref(),
        },
    )?;
    tx.execute(
        "INSERT INTO tasks (id, subject_id, section_id, title, description, due_date, due_time, \
         workdir_override, completed_at, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?9)",
        params![
            id,
            input.subject_id,
            input.section_id,
            title,
            description,
            due_date,
            due_time,
            position,
            now
        ],
    )?;
    journal::add(&tx, &id, JournalKind::Created, "")?;
    tx.commit()?;
    detail(conn, &id)
}

/// A child task at the end of `parent_id`'s subtasks, in its place (one level only:
/// `invalid` under a child). Returns its id.
pub fn create_child(conn: &Connection, parent_id: &str, title: &str) -> AppResult<String> {
    let title = non_empty(title, "subtask")?;
    let parent = load(conn, parent_id)?;
    if parent.parent_id.is_some() {
        return Err(AppError::Invalid(format!(
            "task {parent_id} is a subtask: subtasks have no subtasks"
        )));
    }
    let id = new_id();
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let position = positions::append(&tx, Scope::Subtasks { task_id: parent_id })?;
    tx.execute(
        "INSERT INTO tasks (id, subject_id, section_id, parent_id, title, description, \
         position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?7)",
        params![
            id,
            parent.subject_id,
            parent.section_id,
            parent.id,
            title,
            position,
            now
        ],
    )?;
    journal::add(&tx, &id, JournalKind::Created, "")?;
    tx.commit()?;
    Ok(id)
}

pub fn update(conn: &Connection, input: &UpdateTaskInput) -> AppResult<TaskDetail> {
    let t = load(conn, &input.id)?;
    let title = match &input.title {
        Some(title) => non_empty(title, "task title")?,
        None => t.title,
    };
    let description = input.description.clone().unwrap_or(t.description);
    conn.execute(
        "UPDATE tasks SET title = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
        params![input.id, title, description, now_utc()],
    )?;
    detail(conn, &input.id)
}

pub fn set_due(conn: &Connection, input: &SetDueInput) -> AppResult<TaskDetail> {
    ensure_exists(conn, &input.id)?;
    let (date, time) = validate_due(input.date.as_deref(), input.time.as_deref())?;
    conn.execute(
        "UPDATE tasks SET due_date = ?2, due_time = ?3, updated_at = ?4 WHERE id = ?1",
        params![input.id, date, time, now_utc()],
    )?;
    detail(conn, &input.id)
}

/// Priority 1 to 4; other values are `invalid`.
pub fn set_priority(conn: &Connection, input: &SetPriorityInput) -> AppResult<TaskDetail> {
    if !PRIORITIES.contains(&input.priority) {
        return Err(AppError::Invalid(format!(
            "priority must be 1 to 4: {}",
            input.priority
        )));
    }
    ensure_exists(conn, &input.id)?;
    conn.execute(
        "UPDATE tasks SET priority = ?2, updated_at = ?3 WHERE id = ?1",
        params![input.id, input.priority, now_utc()],
    )?;
    detail(conn, &input.id)
}

pub fn set_workdir_override(
    conn: &Connection,
    input: &SetWorkdirOverrideInput,
) -> AppResult<TaskDetail> {
    ensure_exists(conn, &input.id)?;
    let path = match input.path.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(p) if Path::new(p).is_absolute() => Some(p.to_string()),
        Some(p) => {
            return Err(AppError::Invalid(format!(
                "working folder must be an absolute path: {p}"
            )))
        }
    };
    conn.execute(
        "UPDATE tasks SET workdir_override = ?2, updated_at = ?3 WHERE id = ?1",
        params![input.id, path, now_utc()],
    )?;
    detail(conn, &input.id)
}

/// Checks or unchecks; writes the journal only when the state actually changes. Like
/// Todoist, checking a parent also checks its open children (each journaled), at the same
/// instant; reopening it leaves them as they are.
pub fn set_completed(conn: &Connection, input: &SetCompletedInput) -> AppResult<TaskDetail> {
    let t = load(conn, &input.id)?;
    if t.completed_at.is_some() != input.completed {
        let now = now_utc();
        let (completed_at, kind) = if input.completed {
            (Some(now.clone()), JournalKind::Completed)
        } else {
            (None, JournalKind::Reopened)
        };
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE tasks SET completed_at = ?2, updated_at = ?3 WHERE id = ?1",
            params![input.id, completed_at, now],
        )?;
        journal::add(&tx, &input.id, kind, "")?;
        if input.completed {
            let open_children: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT id FROM tasks WHERE parent_id = ?1 AND completed_at IS NULL \
                     AND deleted_at IS NULL ORDER BY position, id",
                )?;
                let rows = stmt.query_map([&input.id], |r| r.get(0))?;
                rows.collect::<Result<_, _>>()?
            };
            for child in &open_children {
                tx.execute(
                    "UPDATE tasks SET completed_at = ?2, updated_at = ?2 WHERE id = ?1",
                    params![child, now],
                )?;
                journal::add(&tx, child, JournalKind::Completed, "")?;
                time_segments::reconcile(&tx, child, &now)?;
            }
        }
        // Completing stops the chrono; reopening resumes it if Claude still works.
        time_segments::reconcile(&tx, &input.id, &now)?;
        tx.commit()?;
    }
    detail(conn, &input.id)
}

/// Soft delete: the task (and its children, stamped with the same instant) disappears
/// everywhere until [`restore`] or the purge (see `trash`).
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    // Read before the deletion hides the children.
    let family = with_children(&tx, id)?;
    let n = tx.execute(
        "UPDATE tasks SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("task {id}")));
    }
    tx.execute(
        "UPDATE tasks SET deleted_at = ?2 WHERE parent_id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )?;
    for task in &family {
        time_segments::reconcile(&tx, task, &now)?;
    }
    tx.commit()?;
    Ok(())
}

/// Undoes [`delete`]. The task comes back at its place and position with the children
/// deleted with it; `NotFound` when it is not deleted, or when its subject or its parent is
/// deleted (restore that one instead).
pub fn restore(conn: &Connection, id: &str) -> AppResult<TaskDetail> {
    type Deleted = (Option<String>, Option<String>, String);
    let deleted: Option<Deleted> = conn
        .query_row(
            "SELECT subject_id, parent_id, deleted_at FROM tasks \
             WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (subject_id, parent_id, deleted_at) =
        deleted.ok_or_else(|| AppError::NotFound(format!("deleted task {id}")))?;
    if let Some(s) = &subject_id {
        subjects::ensure_exists(conn, s)?;
    }
    if let Some(p) = &parent_id {
        ensure_exists(conn, p)?;
    }
    conn.execute(
        "UPDATE tasks SET deleted_at = NULL WHERE id = ?1 OR (parent_id = ?1 AND deleted_at = ?2)",
        params![id, deleted_at],
    )?;
    detail(conn, id)
}

/// "Reporter à aujourd'hui": every open task due before `today`, subtasks
/// included (« En retard » lists them, on their own or under their late parent), becomes
/// due `today`, keeping its due time. Returns the ids of the rescheduled tasks.
pub fn reschedule_overdue(conn: &Connection, today: NaiveDate) -> AppResult<Vec<String>> {
    let today = today.format("%Y-%m-%d").to_string();
    let tx = conn.unchecked_transaction()?;
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT t.id FROM tasks t WHERE t.due_date < ?1 AND t.completed_at IS NULL \
             AND t.deleted_at IS NULL ORDER BY t.id",
        )?;
        let rows = stmt.query_map([&today], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let now = now_utc();
    for id in &ids {
        tx.execute(
            "UPDATE tasks SET due_date = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, today, now],
        )?;
    }
    tx.commit()?;
    Ok(ids)
}

/// Copies title, description, due date, priority, working folder override and children
/// (with their completion) right after the original; a subtask is copied under the same
/// parent. The copy is open; its journal only has "created".
pub fn duplicate(conn: &Connection, id: &str) -> AppResult<TaskDetail> {
    let t = load(conn, id)?;
    let new = new_id();
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let position = positions::after(&tx, t.scope(), &t.id)?;
    insert_copy(&tx, &t, &new, t.parent_id.as_deref(), None, position, &now)?;
    for child_id in child_ids(&tx, &t.id)? {
        let child = load(&tx, &child_id)?;
        let completed_at = child.completed_at.clone();
        insert_copy(
            &tx,
            &child,
            &new_id(),
            Some(&new),
            completed_at.as_deref(),
            child.position,
            &now,
        )?;
    }
    tx.commit()?;
    detail(conn, &new)
}

/// Inserts a copy of `t` with its "created" journal entry.
fn insert_copy(
    conn: &Connection,
    t: &TaskRecord,
    id: &str,
    parent_id: Option<&str>,
    completed_at: Option<&str>,
    position: f64,
    now: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO tasks (id, subject_id, section_id, parent_id, title, description, \
         due_date, due_time, workdir_override, completed_at, position, priority, created_at, \
         updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            id,
            t.subject_id,
            t.section_id,
            parent_id,
            t.title,
            t.description,
            t.due_date,
            t.due_time,
            t.workdir_override,
            completed_at,
            position,
            t.priority,
            now
        ],
    )?;
    journal::add(conn, id, JournalKind::Created, "")?;
    Ok(())
}

/// Moves a task to a place and index, its children with it. Clears `workdir_override` (the
/// task's and its children's) when the subject changes. A subtask moves only with its
/// parent (`invalid`; `reorder_subtask` orders it).
pub fn move_task(conn: &Connection, input: &MoveTaskInput) -> AppResult<TaskDetail> {
    let t = load(conn, &input.id)?;
    if t.parent_id.is_some() {
        return Err(AppError::Invalid(format!(
            "task {} is a subtask: it moves with its parent",
            t.id
        )));
    }
    validate_place(
        conn,
        input.subject_id.as_deref(),
        input.section_id.as_deref(),
    )?;
    let scope = Scope::Tasks {
        subject_id: input.subject_id.as_deref(),
        section_id: input.section_id.as_deref(),
    };
    let tx = conn.unchecked_transaction()?;
    let position = match input.index {
        Some(i) => positions::at_index(&tx, scope, Some(&t.id), i as usize)?,
        None if t.scope() == scope && is_last(&tx, &t)? => t.position,
        None => positions::append(&tx, scope)?,
    };
    let subject_changed = t.subject_id != input.subject_id;
    let workdir_override = if subject_changed {
        None
    } else {
        t.workdir_override
    };
    let now = now_utc();
    tx.execute(
        "UPDATE tasks SET subject_id = ?2, section_id = ?3, position = ?4, \
         workdir_override = ?5, updated_at = ?6 WHERE id = ?1",
        params![
            t.id,
            input.subject_id,
            input.section_id,
            position,
            workdir_override,
            now
        ],
    )?;
    tx.execute(
        "UPDATE tasks SET subject_id = ?2, section_id = ?3, \
         workdir_override = CASE WHEN ?4 THEN NULL ELSE workdir_override END, updated_at = ?5 \
         WHERE parent_id = ?1",
        params![
            t.id,
            input.subject_id,
            input.section_id,
            subject_changed,
            now
        ],
    )?;
    tx.commit()?;
    detail(conn, &input.id)
}

fn is_last(conn: &Connection, t: &TaskRecord) -> AppResult<bool> {
    let max = positions::append(conn, t.scope())? - 1.0;
    Ok(t.position >= max)
}

/// A section requires its subject; both must exist and match.
fn validate_place(
    conn: &Connection,
    subject_id: Option<&str>,
    section_id: Option<&str>,
) -> AppResult<()> {
    if let Some(s) = subject_id {
        // A group holds no tasks (Taido V2.2 bis).
        subjects::ensure_project(conn, s)?;
    }
    if let Some(sec) = section_id {
        let section = sections::get(conn, sec)?;
        if subject_id != Some(section.subject_id.as_str()) {
            return Err(AppError::Invalid(format!(
                "section {sec} does not belong to the task's subject"
            )));
        }
    }
    Ok(())
}

/// `YYYY-MM-DD` and `HH:MM`; empty strings count as absent; a time requires a date.
pub fn validate_due(
    date: Option<&str>,
    time: Option<&str>,
) -> AppResult<(Option<String>, Option<String>)> {
    let date = date.map(str::trim).filter(|d| !d.is_empty());
    let time = time.map(str::trim).filter(|t| !t.is_empty());
    let date = match date {
        None if time.is_some() => {
            return Err(AppError::Invalid("a due time requires a due date".into()))
        }
        None => return Ok((None, None)),
        Some(d) => d,
    };
    let valid_date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == date);
    if !valid_date {
        return Err(AppError::Invalid(format!(
            "due date must be YYYY-MM-DD: {date}"
        )));
    }
    if let Some(t) = time {
        let valid_time = NaiveTime::parse_from_str(t, "%H:%M")
            .is_ok_and(|parsed| parsed.format("%H:%M").to_string() == t);
        if !valid_time {
            return Err(AppError::Invalid(format!("due time must be HH:MM: {t}")));
        }
    }
    Ok((Some(date.to_string()), time.map(str::to_string)))
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<TaskRecord> {
    Ok(TaskRecord {
        id: r.get(0)?,
        subject_id: r.get(1)?,
        section_id: r.get(2)?,
        parent_id: r.get(3)?,
        title: r.get(4)?,
        description: r.get(5)?,
        due_date: r.get(6)?,
        due_time: r.get(7)?,
        workdir_override: r.get(8)?,
        completed_at: r.get(9)?,
        position: r.get(10)?,
        priority: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::subtasks;
    use crate::db::test_support::{backdate_deletion, section, subject, task, titles_in};
    use crate::model::{AddSubtaskInput, Ring, WorkdirSource};

    fn create_input(title: &str) -> CreateTaskInput {
        CreateTaskInput {
            title: title.into(),
            description: None,
            subject_id: None,
            section_id: None,
            due_date: None,
            due_time: None,
        }
    }

    #[test]
    fn create_defaults_and_detail() {
        let conn = open_in_memory().expect("db");
        let d = create(&conn, &create_input("  Write spec ")).expect("create");
        assert_eq!(d.title, "Write spec");
        assert_eq!(d.description, "");
        assert_eq!(d.ring, Ring::Human);
        assert_eq!(d.line, None);
        assert_eq!(d.subject, None);
        assert_eq!(d.section, None);
        assert_eq!(d.workdir, None);
        assert_eq!(d.git_branch, None);
        assert_eq!(d.completed_at, None);
        assert!(d.subtasks.is_empty());
        assert!(d.created_at.ends_with('Z'));
        assert_eq!(d.created_at, d.updated_at);
        assert_eq!(
            uuid::Uuid::parse_str(&d.id)
                .expect("uuid")
                .get_version_num(),
            7
        );
        assert_eq!(load(&conn, &d.id).expect("load").position, 1.0);
    }

    #[test]
    fn create_validation() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let other = subject(&conn, "O");
        let sec = section(&conn, &other, "Sec");
        type Case<'a> = (
            &'a str,
            Option<&'a str>,
            Option<&'a str>,
            Option<&'a str>,
            Option<&'a str>,
            bool,
        );
        let cases: Vec<Case> = vec![
            ("ok", None, None, None, None, true),
            ("", None, None, None, None, false),
            (
                "ok",
                Some(&s),
                None,
                Some("2026-10-02"),
                Some("09:30"),
                true,
            ),
            ("ok", Some(&s), Some(&sec), None, None, false),
            ("ok", None, Some(&sec), None, None, false),
            ("ok", Some(&other), Some(&sec), None, None, true),
            ("ok", Some("missing"), None, None, None, false),
            ("ok", None, None, None, Some("09:30"), false),
            ("ok", None, None, Some("2026-13-01"), None, false),
            ("ok", None, None, Some("2026-1-01"), None, false),
            ("ok", None, None, Some("02/10/2026"), None, false),
            ("ok", None, None, Some("2026-10-02"), Some("9:30"), false),
            ("ok", None, None, Some("2026-10-02"), Some("24:00"), false),
            ("ok", None, None, Some(""), Some(""), true),
        ];
        for (title, subject_id, section_id, date, time, ok) in cases {
            let res = create(
                &conn,
                &CreateTaskInput {
                    title: title.into(),
                    description: None,
                    subject_id: subject_id.map(String::from),
                    section_id: section_id.map(String::from),
                    due_date: date.map(String::from),
                    due_time: time.map(String::from),
                },
            );
            assert_eq!(
                res.is_ok(),
                ok,
                "{title:?} {subject_id:?} {section_id:?} {date:?} {time:?}"
            );
        }
    }

    #[test]
    fn positions_are_per_place() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let sec = section(&conn, &s, "Sec");
        let a = task(&conn, "a", None, None);
        let b = task(&conn, "b", None, None);
        let c = task(&conn, "c", Some(&s), None);
        let d = task(&conn, "d", Some(&s), Some(&sec));
        let pos = |id: &str| load(&conn, id).expect("load").position;
        assert_eq!((pos(&a), pos(&b), pos(&c), pos(&d)), (1.0, 2.0, 1.0, 1.0));
    }

    #[test]
    fn update_title_and_description() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        let d = update(
            &conn,
            &UpdateTaskInput {
                id: id.clone(),
                title: None,
                description: Some("line one\nline two".into()),
            },
        )
        .expect("update");
        assert_eq!(d.title, "T");
        assert_eq!(d.line.and_then(|l| l.text).as_deref(), Some("line one"));
        let bad = update(
            &conn,
            &UpdateTaskInput {
                id,
                title: Some("  ".into()),
                description: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
    }

    #[test]
    fn due_set_and_clear() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        let set = |date: Option<&str>, time: Option<&str>| {
            set_due(
                &conn,
                &SetDueInput {
                    id: id.clone(),
                    date: date.map(String::from),
                    time: time.map(String::from),
                },
            )
        };
        let d = set(Some("2000-01-01"), Some("08:05")).expect("set");
        let due = d.due.expect("due");
        assert_eq!(due.date, "2000-01-01");
        assert_eq!(due.time.as_deref(), Some("08:05"));
        assert!(due.overdue);
        let d = set(None, None).expect("clear");
        assert_eq!(d.due, None);
        assert!(set(None, Some("08:00")).is_err());
        let rec = load(&conn, &id).expect("load");
        assert_eq!((rec.due_date, rec.due_time), (None, None));
    }

    #[test]
    fn make_due_overdue() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 2).expect("date");
        let cases = [
            ("2026-10-01", true),
            ("2026-10-02", false),
            ("2026-10-03", false),
        ];
        for (date, overdue) in cases {
            let due = make_due(Some(date), None, today).expect("due");
            assert_eq!(due.overdue, overdue, "{date}");
        }
        assert_eq!(make_due(None, Some("10:00"), today), None);
    }

    #[test]
    fn workdir_resolution_in_detail() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let sec_web = sections::create(
            &conn,
            &crate::model::CreateSectionInput {
                subject_id: s.clone(),
                name: "Web".into(),
                subpath: Some("apps/web".into()),
            },
        )
        .expect("section")
        .id;
        let sec_plain = section(&conn, &s, "Plain");
        let root = subjects::get(&conn, &s)
            .expect("subject")
            .root_path
            .expect("root");
        let inbox = task(&conn, "inbox", None, None);
        let in_subject = task(&conn, "s", Some(&s), None);
        let in_web = task(&conn, "w", Some(&s), Some(&sec_web));
        let in_plain = task(&conn, "p", Some(&s), Some(&sec_plain));
        let wd = |id: &str| {
            detail(&conn, id)
                .expect("detail")
                .workdir
                .map(|w| (w.path, w.source))
        };
        assert_eq!(wd(&inbox), None);
        assert_eq!(
            wd(&in_subject),
            Some((root.clone(), WorkdirSource::Subject))
        );
        assert_eq!(
            wd(&in_web),
            Some((format!("{root}/apps/web"), WorkdirSource::Section))
        );
        assert_eq!(wd(&in_plain), Some((root.clone(), WorkdirSource::Subject)));
        let set = |id: &str, path: Option<&str>| {
            set_workdir_override(
                &conn,
                &SetWorkdirOverrideInput {
                    id: id.into(),
                    path: path.map(String::from),
                },
            )
        };
        set(&in_web, Some("/elsewhere")).expect("override");
        assert_eq!(
            wd(&in_web),
            Some(("/elsewhere".to_string(), WorkdirSource::Task))
        );
        set(&inbox, Some("/inbox-dir")).expect("override");
        assert_eq!(
            wd(&inbox),
            Some(("/inbox-dir".to_string(), WorkdirSource::Task))
        );
        assert!(matches!(
            set(&inbox, Some("relative")),
            Err(AppError::Invalid(_))
        ));
        set(&in_web, None).expect("clear");
        assert_eq!(wd(&in_web).map(|w| w.1), Some(WorkdirSource::Section));
    }

    #[test]
    fn git_branch_is_filled_only_for_existing_folders() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        let d = with_git_branch(detail(&conn, &id).expect("detail"));
        assert_eq!(d.git_branch, None);
    }

    #[test]
    fn move_task_rules() {
        let conn = open_in_memory().expect("db");
        let s1 = subject(&conn, "S1");
        let s2 = subject(&conn, "S2");
        let sec1 = section(&conn, &s1, "Sec1");
        let a = task(&conn, "a", Some(&s1), None);
        let b = task(&conn, "b", Some(&s1), None);
        let c = task(&conn, "c", Some(&s1), None);
        set_workdir_override(
            &conn,
            &SetWorkdirOverrideInput {
                id: c.clone(),
                path: Some("/custom".into()),
            },
        )
        .expect("override");
        let mv = |id: &str, subject: Option<&str>, section: Option<&str>, index: Option<u32>| {
            move_task(
                &conn,
                &MoveTaskInput {
                    id: id.into(),
                    subject_id: subject.map(String::from),
                    section_id: section.map(String::from),
                    index,
                },
            )
        };
        // Reorder inside the same place: keeps the override.
        let d = mv(&c, Some(&s1), None, Some(0)).expect("move");
        assert_eq!(d.workdir_override.as_deref(), Some("/custom"));
        assert_eq!(titles_in(&conn, Some(&s1), None), vec!["c", "a", "b"]);
        // To a section of the same subject: keeps the override.
        let d = mv(&c, Some(&s1), Some(&sec1), None).expect("move");
        assert_eq!(d.workdir_override.as_deref(), Some("/custom"));
        assert_eq!(d.section.map(|s| s.id), Some(sec1.clone()));
        // To another subject: clears it.
        let d = mv(&c, Some(&s2), None, None).expect("move");
        assert_eq!(d.workdir_override, None);
        assert_eq!(d.subject.map(|s| s.id), Some(s2.clone()));
        // To the inbox, at index 0 of an empty place.
        let d = mv(&a, None, None, Some(0)).expect("move");
        assert_eq!(d.subject, None);
        // Index past the end appends.
        mv(&a, Some(&s1), None, Some(10)).expect("move");
        assert_eq!(titles_in(&conn, Some(&s1), None), vec!["b", "a"]);
        // Same place, no index, already last: unchanged.
        let before = load(&conn, &a).expect("load").position;
        mv(&a, Some(&s1), None, None).expect("move");
        assert_eq!(load(&conn, &a).expect("load").position, before);
        // Invalid places.
        assert!(matches!(
            mv(&b, Some(&s2), Some(&sec1), None),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            mv(&b, None, Some(&sec1), None),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            mv("nope", None, None, None),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn reorder_ignores_completed_siblings() {
        let conn = open_in_memory().expect("db");
        let a = task(&conn, "a", None, None);
        let b = task(&conn, "b", None, None);
        let c = task(&conn, "c", None, None);
        set_completed(
            &conn,
            &SetCompletedInput {
                id: b.clone(),
                completed: true,
            },
        )
        .expect("complete");
        // Visible: a, c. Move c before a.
        move_task(
            &conn,
            &MoveTaskInput {
                id: c.clone(),
                subject_id: None,
                section_id: None,
                index: Some(0),
            },
        )
        .expect("move");
        assert_eq!(titles_in(&conn, None, None), vec!["c", "a", "b"]);
        let _ = a;
    }

    #[test]
    fn complete_and_reopen() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        let set = |completed| {
            set_completed(
                &conn,
                &SetCompletedInput {
                    id: id.clone(),
                    completed,
                },
            )
            .expect("set")
        };
        let d = set(true);
        assert_eq!(d.ring, Ring::Completed);
        let at = d.completed_at.clone().expect("completed_at");
        assert_eq!(d.ring_since.as_deref(), Some(at.as_str()));
        assert_eq!(d.line.expect("line").at.as_deref(), Some(at.as_str()));
        // Checking again keeps the original instant.
        assert_eq!(set(true).completed_at.as_deref(), Some(at.as_str()));
        let d = set(false);
        assert_eq!(d.ring, Ring::Human);
        assert_eq!(d.completed_at, None);
        assert_eq!(d.ring_since, None);
    }

    #[test]
    fn soft_delete_restore_then_purge_cascades() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        let add_child = |text: &str| {
            subtasks::add(
                &conn,
                &AddSubtaskInput {
                    task_id: id.clone(),
                    text: text.into(),
                },
            )
            .expect("subtask")
            .id
        };
        let kept = add_child("kept");
        let gone = add_child("deleted before");
        delete(&conn, &gone).expect("delete subtask");
        backdate_deletion(&conn, "tasks", &gone);
        delete(&conn, &id).expect("delete");
        assert!(matches!(load(&conn, &id), Err(AppError::NotFound(_))));
        assert!(matches!(load(&conn, &kept), Err(AppError::NotFound(_))));
        assert!(matches!(detail(&conn, &id), Err(AppError::NotFound(_))));
        assert!(matches!(delete(&conn, &id), Err(AppError::NotFound(_))));
        assert!(matches!(
            journal::list(&conn, &id),
            Err(AppError::NotFound(_))
        ));
        // A subtask comes back with its parent only.
        assert!(matches!(restore(&conn, &kept), Err(AppError::NotFound(_))));
        let back = restore(&conn, &id).expect("restore");
        let subs: Vec<&str> = back.subtasks.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(subs, vec![kept.as_str()]);
        assert!(matches!(restore(&conn, &id), Err(AppError::NotFound(_))));
        assert!(matches!(restore(&conn, "nope"), Err(AppError::NotFound(_))));

        delete(&conn, &id).expect("delete");
        let later = chrono::Utc::now() + chrono::Duration::days(2);
        crate::db::trash::purge(&conn, later).expect("purge");
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .expect("count")
        };
        assert_eq!(count("tasks"), 0);
        assert_eq!(count("journal_entries"), 0);
    }

    #[test]
    fn restore_requires_a_live_subject() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let t = task(&conn, "T", Some(&s), None);
        delete(&conn, &t).expect("delete task");
        backdate_deletion(&conn, "tasks", &t);
        subjects::delete(&conn, &s).expect("delete subject");
        assert!(matches!(restore(&conn, &t), Err(AppError::NotFound(_))));
        subjects::restore(&conn, &s).expect("restore subject");
        assert_eq!(restore(&conn, &t).expect("restore").title, "T");
    }

    #[test]
    fn deleted_tasks_do_not_count_as_siblings() {
        let conn = open_in_memory().expect("db");
        let a = task(&conn, "a", None, None);
        let b = task(&conn, "b", None, None);
        let c = task(&conn, "c", None, None);
        delete(&conn, &a).expect("delete");
        // Visible: b, c. Index 1 = after b, i.e. c moves nowhere; move c to index 0.
        move_task(
            &conn,
            &MoveTaskInput {
                id: c.clone(),
                subject_id: None,
                section_id: None,
                index: Some(0),
            },
        )
        .expect("move");
        let pb = load(&conn, &b).expect("b").position;
        let pc = load(&conn, &c).expect("c").position;
        assert!(pc < pb);
    }

    #[test]
    fn reschedule_overdue_moves_open_late_tasks_to_today() {
        let conn = open_in_memory().expect("db");
        let today = NaiveDate::from_ymd_opt(2026, 10, 2).expect("date");
        let mk = |title: &str, date: Option<&str>, time: Option<&str>| {
            let id = task(&conn, title, None, None);
            set_due(
                &conn,
                &SetDueInput {
                    id: id.clone(),
                    date: date.map(String::from),
                    time: time.map(String::from),
                },
            )
            .expect("due");
            id
        };
        let late = mk("late", Some("2026-09-28"), Some("09:15"));
        let yesterday = mk("yesterday", Some("2026-10-01"), None);
        let on_time = mk("today", Some("2026-10-02"), None);
        let future = mk("future", Some("2026-10-05"), None);
        let none = mk("none", None, None);
        let done = mk("done", Some("2026-09-01"), None);
        set_completed(
            &conn,
            &SetCompletedInput {
                id: done.clone(),
                completed: true,
            },
        )
        .expect("complete");
        let gone = mk("gone", Some("2026-09-01"), None);
        delete(&conn, &gone).expect("delete");
        // Late subtasks move too, whether their parent is late or not.
        let sub = |parent: &str, title: &str| {
            let id = crate::db::subtasks::add(
                &conn,
                &crate::model::AddSubtaskInput {
                    task_id: parent.into(),
                    text: title.into(),
                },
            )
            .expect("subtask")
            .id;
            set_due(
                &conn,
                &SetDueInput {
                    id: id.clone(),
                    date: Some("2026-09-30".into()),
                    time: None,
                },
            )
            .expect("due");
            id
        };
        let lone_sub = sub(&future, "lone sub");
        let nested_sub = sub(&late, "nested sub");

        let mut moved = reschedule_overdue(&conn, today).expect("reschedule");
        moved.sort();
        let mut expected = vec![
            late.clone(),
            yesterday.clone(),
            lone_sub.clone(),
            nested_sub.clone(),
        ];
        expected.sort();
        assert_eq!(moved, expected);
        let due_of = |id: &str| {
            let r = load(&conn, id).expect("load");
            (r.due_date, r.due_time)
        };
        assert_eq!(
            due_of(&late),
            (Some("2026-10-02".into()), Some("09:15".into()))
        );
        assert_eq!(due_of(&yesterday), (Some("2026-10-02".into()), None));
        assert_eq!(due_of(&on_time), (Some("2026-10-02".into()), None));
        assert_eq!(due_of(&future), (Some("2026-10-05".into()), None));
        assert_eq!(due_of(&none), (None, None));
        assert_eq!(due_of(&done), (Some("2026-09-01".into()), None));
        assert_eq!(due_of(&lone_sub), (Some("2026-10-02".into()), None));
        assert_eq!(due_of(&nested_sub), (Some("2026-10-02".into()), None));
        assert!(reschedule_overdue(&conn, today).expect("again").is_empty());
    }

    #[test]
    fn subject_without_folder_has_no_workdir() {
        let conn = open_in_memory().expect("db");
        let s = subjects::create(
            &conn,
            &crate::model::CreateSubjectInput {
                name: "No folder".into(),
                color: None,
                root_path: None,
                parent_id: None,
            },
        )
        .expect("subject")
        .id;
        let sec = sections::create(
            &conn,
            &crate::model::CreateSectionInput {
                subject_id: s.clone(),
                name: "Web".into(),
                subpath: Some("web".into()),
            },
        )
        .expect("section")
        .id;
        let t = task(&conn, "t", Some(&s), Some(&sec));
        assert_eq!(detail(&conn, &t).expect("detail").workdir, None);
        let d = set_workdir_override(
            &conn,
            &SetWorkdirOverrideInput {
                id: t.clone(),
                path: Some("/picked".into()),
            },
        )
        .expect("override");
        assert_eq!(
            d.workdir.map(|w| (w.path, w.source)),
            Some(("/picked".to_string(), WorkdirSource::Task))
        );
    }

    #[test]
    fn deleting_subject_deletes_its_tasks() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let t = task(&conn, "T", Some(&s), None);
        let keep = task(&conn, "inbox", None, None);
        subjects::delete(&conn, &s).expect("delete");
        assert!(matches!(load(&conn, &t), Err(AppError::NotFound(_))));
        assert!(load(&conn, &keep).is_ok());
    }

    #[test]
    fn duplicate_copies_after_original() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let a = task(&conn, "a", Some(&s), None);
        let b = task(&conn, "b", Some(&s), None);
        update(
            &conn,
            &UpdateTaskInput {
                id: a.clone(),
                title: None,
                description: Some("desc".into()),
            },
        )
        .expect("update");
        set_due(
            &conn,
            &SetDueInput {
                id: a.clone(),
                date: Some("2026-10-05".into()),
                time: Some("14:00".into()),
            },
        )
        .expect("due");
        for text in ["one", "two"] {
            subtasks::add(
                &conn,
                &AddSubtaskInput {
                    task_id: a.clone(),
                    text: text.into(),
                },
            )
            .expect("subtask");
        }
        let first = subtasks::list_for_task(&conn, &a).expect("list")[0]
            .id
            .clone();
        subtasks::toggle(&conn, &first).expect("toggle");
        // A completed original with an open child (completing it would complete "two").
        conn.execute(
            "UPDATE tasks SET completed_at = '2026-10-02T10:00:00.000Z' WHERE id = ?1",
            [&a],
        )
        .expect("complete");

        let copy = duplicate(&conn, &a).expect("duplicate");
        assert_ne!(copy.id, a);
        assert_eq!(copy.title, "a");
        assert_eq!(copy.description, "desc");
        assert_eq!(
            copy.due.as_ref().map(|d| d.date.as_str()),
            Some("2026-10-05")
        );
        assert_eq!(
            copy.due.as_ref().and_then(|d| d.time.as_deref()),
            Some("14:00")
        );
        assert_eq!(copy.completed_at, None);
        let subs: Vec<_> = copy
            .subtasks
            .iter()
            .map(|s| (s.text.as_str(), s.done))
            .collect();
        // Open subtasks first, then completed ones.
        assert_eq!(subs, vec![("two", false), ("one", true)]);
        assert!(copy.subtasks.iter().all(|s| s.task_id == copy.id));
        assert_eq!(
            subtasks::list_for_task(&conn, &a).expect("original").len(),
            2
        );
        let pa = load(&conn, &a).expect("a").position;
        let pb = load(&conn, &b).expect("b").position;
        let pc = load(&conn, &copy.id).expect("copy").position;
        assert!(pa < pc && pc < pb);
        let journal: Vec<_> = journal::list(&conn, &copy.id)
            .expect("journal")
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(journal, vec![JournalKind::Created]);

        // A subtask is copied under the same parent, right after itself.
        let two = copy.subtasks[0].id.clone();
        let twin = duplicate(&conn, &two).expect("duplicate subtask");
        assert_eq!(twin.parent.map(|p| p.id), Some(copy.id.clone()));
        let after = detail(&conn, &copy.id).expect("copy");
        let texts: Vec<&str> = after.subtasks.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["two", "two", "one"]);
    }

    #[test]
    fn children_follow_their_parent() {
        let conn = open_in_memory().expect("db");
        let s1 = subject(&conn, "S1");
        let s2 = subject(&conn, "S2");
        let sec1 = section(&conn, &s1, "Sec1");
        let parent = task(&conn, "parent", Some(&s1), Some(&sec1));
        let sibling = task(&conn, "sibling", Some(&s1), Some(&sec1));
        let child = subtasks::add(
            &conn,
            &AddSubtaskInput {
                task_id: parent.clone(),
                text: "child".into(),
            },
        )
        .expect("subtask")
        .id;
        // Children are not siblings of top-level tasks.
        assert_eq!(load(&conn, &sibling).expect("sibling").position, 2.0);
        assert_eq!(load(&conn, &child).expect("child").position, 1.0);
        let set_override = |id: &str, path: Option<&str>| {
            set_workdir_override(
                &conn,
                &SetWorkdirOverrideInput {
                    id: id.into(),
                    path: path.map(String::from),
                },
            )
            .expect("override")
        };
        // The child works in its parent's folder, unless it has its own.
        let wd = |id: &str| {
            detail(&conn, id)
                .expect("detail")
                .workdir
                .map(|w| (w.path, w.source))
        };
        assert_eq!(wd(&child), Some(("/tmp/S1".into(), WorkdirSource::Subject)));
        set_override(&parent, Some("/parent"));
        assert_eq!(wd(&child), Some(("/parent".into(), WorkdirSource::Task)));
        set_override(&child, Some("/child"));
        assert_eq!(wd(&child), Some(("/child".into(), WorkdirSource::Task)));
        let d = detail(&conn, &child).expect("child detail");
        assert_eq!(
            d.parent,
            Some(TaskRef {
                id: parent.clone(),
                title: "parent".into()
            })
        );
        assert!(d.subtasks.is_empty());

        // A subtask does not move on its own.
        let mv = |id: &str, subject: Option<&str>, section: Option<&str>| {
            move_task(
                &conn,
                &MoveTaskInput {
                    id: id.into(),
                    subject_id: subject.map(String::from),
                    section_id: section.map(String::from),
                    index: None,
                },
            )
        };
        assert!(matches!(
            mv(&child, Some(&s2), None),
            Err(AppError::Invalid(_))
        ));
        // Same subject: overrides kept.
        mv(&parent, Some(&s1), None).expect("move");
        let c = load(&conn, &child).expect("child");
        assert_eq!(
            (c.subject_id.as_deref(), c.section_id),
            (Some(s1.as_str()), None)
        );
        assert_eq!(c.workdir_override.as_deref(), Some("/child"));
        // Another subject: cleared, like the parent's.
        mv(&parent, Some(&s2), None).expect("move");
        let c = load(&conn, &child).expect("child");
        assert_eq!(c.subject_id.as_deref(), Some(s2.as_str()));
        assert_eq!(c.workdir_override, None);
        assert_eq!(load(&conn, &parent).expect("parent").workdir_override, None);

        // Completing the parent completes its open children too (like Todoist), journaled;
        // a child completed before keeps its own instant.
        let early = subtasks::add(
            &conn,
            &AddSubtaskInput {
                task_id: parent.clone(),
                text: "early".into(),
            },
        )
        .expect("subtask")
        .id;
        subtasks::toggle(&conn, &early).expect("toggle");
        let early_at = load(&conn, &early).expect("early").completed_at;
        let set = |completed: bool| {
            set_completed(
                &conn,
                &SetCompletedInput {
                    id: parent.clone(),
                    completed,
                },
            )
            .expect("set")
        };
        let done = set(true);
        assert!(done.subtasks.iter().all(|s| s.done));
        assert_eq!(
            load(&conn, &child).expect("child").completed_at,
            done.completed_at
        );
        assert_eq!(load(&conn, &early).expect("early").completed_at, early_at);
        let kinds = |id: &str| -> Vec<JournalKind> {
            journal::list(&conn, id)
                .expect("journal")
                .into_iter()
                .map(|e| e.kind)
                .collect()
        };
        assert!(kinds(&child).contains(&JournalKind::Completed));
        assert_eq!(
            with_children(&conn, &parent).expect("ids"),
            vec![parent.clone(), child.clone(), early]
        );
        // Reopening the parent leaves its children as they are.
        let open = set(false);
        assert_eq!(open.completed_at, None);
        assert!(open.subtasks.iter().all(|s| s.done));
    }

    #[test]
    fn priority_is_one_to_four() {
        let conn = open_in_memory().expect("db");
        let id = task(&conn, "T", None, None);
        assert_eq!(detail(&conn, &id).expect("detail").priority, 1);
        let set = |priority: u8| {
            set_priority(
                &conn,
                &SetPriorityInput {
                    id: id.clone(),
                    priority,
                },
            )
        };
        for p in 1..=4 {
            assert_eq!(set(p).expect("set").priority, p);
        }
        for p in [0, 5, 255] {
            assert!(matches!(set(p), Err(AppError::Invalid(_))), "{p}");
        }
        assert_eq!(load(&conn, &id).expect("load").priority, 4);
        assert!(matches!(
            set_priority(
                &conn,
                &SetPriorityInput {
                    id: "nope".into(),
                    priority: 2,
                },
            ),
            Err(AppError::NotFound(_))
        ));
        // Duplicates keep it.
        assert_eq!(duplicate(&conn, &id).expect("copy").priority, 4);
    }
}
