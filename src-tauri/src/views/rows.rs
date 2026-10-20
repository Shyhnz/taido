//! Loading task facts for the list views and turning them into `TaskRow`s.
//!
//! A subtask is a child task (one level). Lists hold top-level tasks only;
//! each carries its children, and its ring sums up its own sessions and theirs.

use std::collections::HashMap;

use chrono::{DateTime, Local, NaiveDate};
use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, Row};

use crate::db::agent_sessions;
use crate::db::subjects::parse_color;
use crate::db::tasks::make_due;
use crate::db::time_segments;
use crate::error::AppResult;
use crate::model::{Ring, SubjectTag, Subtask, TaskChrono, TaskLine, TaskRow};
use crate::state::derive::{self, RingInput, SessionFacts};

/// What a list view needs to know about a task.
#[derive(Debug, Clone)]
pub struct TaskFacts {
    pub id: String,
    pub title: String,
    pub description: String,
    pub subject: Option<SubjectTag>,
    /// Sidebar order of the subject: (position of the top-level project, position of the
    /// sub-project among its siblings or `None` for a top-level project).
    pub subject_order: Option<(f64, Option<f64>)>,
    pub section_id: Option<String>,
    pub parent_id: Option<String>,
    pub priority: u8,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub completed_at: Option<String>,
    pub position: f64,
    /// Terminals whose process is running (`closed_at` not set).
    pub open_terminals: u32,
    /// Claude sessions the ring is derived from: the task's own and its children's (not
    /// loaded for the task itself in completed lists: its ring is Completed).
    pub sessions: Vec<SessionFacts>,
    /// Live child tasks: open ones by position, then completed ones, most recent first.
    pub children: Vec<TaskFacts>,
    /// The task's own chrono.
    pub chrono: Option<TaskChrono>,
    /// Its kanban column, `None` = the first one.
    pub board_column_id: Option<String>,
    /// Number of attachments.
    pub attachment_count: u32,
    pub blocks_count: u32,
    pub blocked_by: Option<String>,
    pub blocked_by_count: u32,
    pub related_count: u32,
}

impl TaskFacts {
    fn ring_input(&self) -> RingInput<'_> {
        RingInput {
            completed_at: self.completed_at.as_deref(),
            description: &self.description,
            sessions: &self.sessions,
        }
    }

    pub fn ring(&self) -> Ring {
        derive::ring(&self.ring_input())
    }

    /// Ring from the task's own sessions, its children's left out (they come last in
    /// `sessions`, see [`load`]).
    pub fn own_ring(&self) -> Ring {
        let theirs: usize = self.children.iter().map(|c| c.sessions.len()).sum();
        let own = self.sessions.len().saturating_sub(theirs);
        derive::ring(&RingInput {
            sessions: &self.sessions[..own],
            ..self.ring_input()
        })
    }

    /// Second line of the row.
    pub fn row_line(&self) -> Option<TaskLine> {
        let input = self.ring_input();
        derive::row_line(&input, derive::ring(&input))
    }

    /// Second line of the panel and the instant the ring state started.
    pub fn detail_line(&self) -> (Ring, Option<TaskLine>, Option<String>) {
        let input = self.ring_input();
        let ring = derive::ring(&input);
        (
            ring,
            derive::line(&input, ring),
            derive::ring_since(&input, ring),
        )
    }

    /// Local date of completion, if completed.
    pub fn completed_on(&self) -> Option<NaiveDate> {
        let at = self.completed_at.as_deref()?;
        DateTime::parse_from_rfc3339(at)
            .ok()
            .map(|d| d.with_timezone(&Local).date_naive())
    }

    /// (completed, all) children.
    fn children_counts(&self) -> (u32, u32) {
        let done = self
            .children
            .iter()
            .filter(|c| c.completed_at.is_some())
            .count();
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        (count(done), count(self.children.len()))
    }

    /// Row for a list view; `with_subject` in multi-subject views only.
    pub fn to_row(&self, today: NaiveDate, with_subject: bool) -> TaskRow {
        let input = self.ring_input();
        let ring = derive::ring(&input);
        let (subtasks_done, subtasks_total) = self.children_counts();
        TaskRow {
            id: self.id.clone(),
            title: self.title.clone(),
            subject: if with_subject {
                self.subject.clone()
            } else {
                None
            },
            subject_id: self.subject.as_ref().map(|s| s.id.clone()),
            section_id: self.section_id.clone(),
            ring,
            line: derive::row_line(&input, ring),
            has_description: !self.description.trim().is_empty(),
            due: make_due(self.due_date.as_deref(), self.due_time.as_deref(), today),
            open_terminals: self.open_terminals,
            subtasks_done,
            subtasks_total,
            completed_at: self.completed_at.clone(),
            position: self.position,
            priority: self.priority,
            parent_id: self.parent_id.clone(),
            children: self
                .children
                .iter()
                .map(|c| c.to_row(today, with_subject))
                .collect(),
            chrono: self.chrono.clone(),
            attachment_count: self.attachment_count,
            blocks_count: self.blocks_count,
            blocked_by: self.blocked_by.clone(),
            blocked_by_count: self.blocked_by_count,
            related_count: self.related_count,
        }
    }

    /// A child task as its parent's panel lists it.
    pub fn to_subtask(&self, parent_id: &str, today: NaiveDate) -> Subtask {
        Subtask {
            id: self.id.clone(),
            task_id: parent_id.to_string(),
            text: self.title.clone(),
            done: self.completed_at.is_some(),
            position: self.position,
            ring: self.ring(),
            priority: self.priority,
            due: make_due(self.due_date.as_deref(), self.due_time.as_deref(), today),
            open_terminals: self.open_terminals,
        }
    }
}

/// Which tasks to load.
#[derive(Debug, Clone, Copy)]
pub enum Filter<'a> {
    /// Open or completed top-level tasks without subject ("Sans projet"). Open lists also
    /// hold the open children of a completed parent (`listed_open_sql`).
    Inbox { completed: bool },
    /// Open or completed top-level tasks of a subject.
    Subject { id: &'a str, completed: bool },
    /// Open or completed top-level tasks, everywhere.
    All { completed: bool },
    /// The given live tasks, open or completed, children included (state change events,
    /// search, the panel).
    Ids(&'a [String]),
}

/// Order of the children of a task.
const CHILD_ORDER: &str = "t.completed_at IS NOT NULL, \
    CASE WHEN t.completed_at IS NULL THEN t.position END, t.completed_at DESC, t.id";

/// Loads tasks by position (open) or most recently completed first (completed), with their
/// children and their sessions: three more queries for the whole list, never one per task.
pub fn load(conn: &Connection, filter: Filter<'_>) -> AppResult<Vec<TaskFacts>> {
    let (place, params, completed): (String, Vec<Value>, Option<bool>) = match filter {
        Filter::Inbox { completed } => ("t.subject_id IS NULL".into(), vec![], Some(completed)),
        Filter::Subject { id, completed } => (
            "t.subject_id = ?".into(),
            vec![Value::Text(id.to_string())],
            Some(completed),
        ),
        Filter::All { completed } => ("1 = 1".into(), vec![], Some(completed)),
        Filter::Ids(ids) => (
            format!("t.id IN ({})", vec!["?"; ids.len()].join(", ")),
            ids.iter().map(|id| Value::Text(id.clone())).collect(),
            None,
        ),
    };
    if params.is_empty() && matches!(filter, Filter::Ids(_)) {
        return Ok(Vec::new());
    }
    let (state, order) = match completed {
        Some(true) => (
            "t.completed_at IS NOT NULL",
            "t.completed_at DESC, t.id DESC",
        ),
        Some(false) => ("t.completed_at IS NULL", "t.position, t.id"),
        None => ("1 = 1", "t.position, t.id"),
    };
    // Open lists also show the open children of a completed parent on their own; completed
    // lists show top-level tasks with their completed children only.
    let top_level = match (filter, completed) {
        (Filter::Ids(_), _) => "",
        (_, Some(false)) => concat!(" AND ", crate::db::listed_open_sql!()),
        _ => " AND t.parent_id IS NULL",
    };
    let condition = format!("{place} AND {state} AND t.deleted_at IS NULL{top_level}");
    let mut tasks = query(conn, &condition, &params, order)?;
    if tasks.is_empty() {
        return Ok(tasks);
    }
    if completed != Some(true) {
        let mut sessions = agent_sessions::facts_where(conn, &condition, params.clone())?;
        for t in &mut tasks {
            t.sessions = sessions.remove(&t.id).unwrap_or_default();
        }
    }
    // The inner `t` is the loaded task; the outer one its child.
    let child_state = if completed == Some(true) {
        " AND t.completed_at IS NOT NULL"
    } else {
        ""
    };
    let child_condition = format!(
        "t.parent_id IN (SELECT t.id FROM tasks t WHERE {condition}) AND t.deleted_at IS NULL\
         {child_state}"
    );
    let mut children = query(conn, &child_condition, &params, CHILD_ORDER)?;
    if children.is_empty() {
        return Ok(tasks);
    }
    let mut sessions = agent_sessions::facts_where(conn, &child_condition, params)?;
    let mut by_parent: HashMap<String, Vec<TaskFacts>> = HashMap::new();
    for mut child in children.drain(..) {
        child.sessions = sessions.remove(&child.id).unwrap_or_default();
        if let Some(parent) = child.parent_id.clone() {
            by_parent.entry(parent).or_default().push(child);
        }
    }
    for t in &mut tasks {
        // Filter::Ids may load a parent twice: each copy gets the children.
        let Some(children) = by_parent.get(&t.id) else {
            continue;
        };
        t.sessions
            .extend(children.iter().flat_map(|c| c.sessions.iter().cloned()));
        t.children = children.clone();
    }
    Ok(tasks)
}

fn query(
    conn: &Connection,
    condition: &str,
    params: &[Value],
    order: &str,
) -> AppResult<Vec<TaskFacts>> {
    let sql = format!(
        "SELECT t.id, t.title, t.description, t.subject_id, s.name, s.color, \
         COALESCE(ps.position, s.position), \
         t.section_id, t.due_date, t.due_time, t.completed_at, t.position, t.parent_id, \
         t.priority, CASE WHEN s.parent_id IS NOT NULL THEN s.position END, \
         (SELECT COUNT(*) FROM terminals tm WHERE tm.task_id = t.id AND tm.closed_at IS NULL), \
         {count}, {seconds}, {running}, t.board_column_id, \
         (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id AND a.deleted_at IS NULL), \
         {blocks}, {blocked_by}, {blocked_by_count}, {related} \
         FROM tasks t LEFT JOIN subjects s ON s.id = t.subject_id \
         LEFT JOIN subjects ps ON ps.id = s.parent_id \
         WHERE {condition} ORDER BY {order}",
        count = time_segments::COUNT_SQL,
        seconds = time_segments::STOPPED_SECONDS_SQL,
        running = time_segments::RUNNING_SINCE_SQL,
        blocks = crate::db::relations::BLOCKS_SQL,
        blocked_by = crate::db::relations::BLOCKED_BY_SQL,
        blocked_by_count = crate::db::relations::BLOCKED_BY_COUNT_SQL,
        related = crate::db::relations::RELATED_SQL,
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<TaskFacts> {
    let subject_id: Option<String> = r.get(3)?;
    let subject = match subject_id {
        Some(id) => Some(SubjectTag {
            id,
            name: r.get(4)?,
            color: parse_color(&r.get::<_, String>(5)?),
        }),
        None => None,
    };
    let sub_position: Option<f64> = r.get(14)?;
    Ok(TaskFacts {
        id: r.get(0)?,
        title: r.get(1)?,
        description: r.get(2)?,
        subject,
        subject_order: r.get::<_, Option<f64>>(6)?.map(|top| (top, sub_position)),
        section_id: r.get(7)?,
        due_date: r.get(8)?,
        due_time: r.get(9)?,
        completed_at: r.get(10)?,
        position: r.get(11)?,
        parent_id: r.get(12)?,
        priority: r.get(13)?,
        open_terminals: r.get(15)?,
        sessions: Vec::new(),
        children: Vec::new(),
        chrono: time_segments::chrono_of(r.get(16)?, r.get(17)?, r.get(18)?),
        board_column_id: r.get(19)?,
        attachment_count: r.get(20)?,
        blocks_count: r.get(21)?,
        blocked_by: r.get(22)?,
        blocked_by_count: r.get(23)?,
        related_count: r.get(24)?,
    })
}
