//! View models ready to display. Pure functions of the database and of `today`
//! (the local date), so that tests run against a fixed date. Soft-deleted rows never show.

pub mod board;
pub mod candidates;
pub mod dashboard;
pub mod notes;
pub mod portfolio;
pub mod rows;
pub mod search;
#[cfg(test)]
mod tests;

use std::cmp::Ordering;
use std::collections::HashMap;

use chrono::NaiveDate;
use rusqlite::Connection;

use crate::db::{subjects, top_level};
use crate::error::{AppError, AppResult};
use crate::model::{
    AddTarget, Counts, GetViewInput, GroupKey, GroupOrder, Ring, SubjectDot, TaskGroup, TaskRow,
    ViewKind, ViewModel,
};
use crate::state::derive;
use rows::{Filter, TaskFacts};

/// Days « Prochainement » shows by default, and at most.
pub const UPCOMING_DAYS: u32 = 7;
pub const UPCOMING_MAX_DAYS: u32 = 62;

pub fn get_view(conn: &Connection, input: &GetViewInput, today: NaiveDate) -> AppResult<ViewModel> {
    match input.kind {
        ViewKind::Inbox => inbox(conn, today),
        ViewKind::Today => today_view(conn, today),
        ViewKind::All => all_view(conn, today),
        ViewKind::Upcoming => upcoming(conn, input.from.as_deref(), input.days, today),
        // The screen reads `get_portfolio`; the view itself is empty.
        ViewKind::Portfolio => Ok(ViewModel {
            kind: ViewKind::Portfolio,
            subject: None,
            groups: Vec::new(),
            open_count: 0,
            completed: Vec::new(),
            today: format_date(today),
        }),
        ViewKind::Subject => {
            let id = input
                .subject_id
                .as_deref()
                .ok_or_else(|| AppError::Invalid("subject view requires a subject id".into()))?;
            subject_view(conn, id, today)
        }
    }
}

/// Sidebar counters.
pub fn counts(conn: &Connection, today: NaiveDate) -> AppResult<Counts> {
    let inbox: u32 = conn.query_row(
        concat!(
            "SELECT COUNT(*) FROM tasks t WHERE t.subject_id IS NULL \
             AND t.completed_at IS NULL AND t.deleted_at IS NULL AND ",
            crate::db::listed_open_sql!()
        ),
        [],
        |r| r.get(0),
    )?;
    let today_view = today_view(conn, today)?;
    let waiting = today_view
        .groups
        .iter()
        .flat_map(|g| &g.tasks)
        .filter(|t| t.ring == Ring::Waiting)
        .count();
    Ok(Counts {
        inbox,
        today: today_view.open_count,
        waiting: u32::try_from(waiting).unwrap_or(u32::MAX),
    })
}

/// Dot of every subject that has one, from the rings of its open tasks; a
/// parent's dot also sums up its sub-projects' tasks.
pub fn subject_dots(conn: &Connection) -> AppResult<HashMap<String, SubjectDot>> {
    let parents = subjects::parents(conn)?;
    let mut rings: HashMap<String, Vec<Ring>> = HashMap::new();
    for t in rows::load(conn, Filter::All { completed: false })? {
        if let Some(subject) = &t.subject {
            let ring = t.ring();
            rings.entry(subject.id.clone()).or_default().push(ring);
            if let Some(parent) = parents.get(&subject.id) {
                rings.entry(parent.clone()).or_default().push(ring);
            }
        }
    }
    Ok(rings
        .into_iter()
        .filter_map(|(id, rings)| derive::subject_dot(rings).map(|dot| (id, dot)))
        .collect())
}

/// Dot of one subject, its sub-projects' tasks included.
pub fn subject_dot(conn: &Connection, subject_id: &str) -> AppResult<Option<SubjectDot>> {
    let mut ids = vec![subject_id.to_string()];
    ids.extend(subjects::child_ids(conn, subject_id)?);
    let mut rings = Vec::new();
    for id in &ids {
        let open = rows::load(
            conn,
            Filter::Subject {
                id,
                completed: false,
            },
        )?;
        rings.extend(open.iter().map(TaskFacts::ring));
    }
    Ok(derive::subject_dot(rings))
}

/// "Sans projet" (D2): one list without header, adding without project.
fn inbox(conn: &Connection, today: NaiveDate) -> AppResult<ViewModel> {
    let open = rows::load(conn, Filter::Inbox { completed: false })?;
    let completed = rows::load(conn, Filter::Inbox { completed: true })?;
    let tasks: Vec<TaskRow> = open.iter().map(|t| t.to_row(today, false)).collect();
    Ok(ViewModel {
        kind: ViewKind::Inbox,
        subject: None,
        open_count: count(&tasks),
        groups: vec![TaskGroup {
            key: GroupKey::Inbox,
            show_header: false,
            order: None,
            tasks,
            add_target: Some(AddTarget {
                subject_id: None,
                section_id: None,
                due_today: false,
                due_date: None,
            }),
        }],
        completed: completed.iter().map(|t| t.to_row(today, false)).collect(),
        today: format_date(today),
    })
}

/// Open tasks that match, plus the open subtasks that match on their own when their parent
/// does not (like Todoist: a dated subtask shows on its day, with its parent's project). A
/// subtask whose parent matches stays nested under it.
fn dated(open: &[TaskFacts], matches: impl Fn(&TaskFacts) -> bool) -> Vec<&TaskFacts> {
    let mut out = Vec::new();
    for t in open {
        if matches(t) {
            out.push(t);
        } else {
            out.extend(
                t.children
                    .iter()
                    .filter(|c| c.completed_at.is_none() && matches(c)),
            );
        }
    }
    out
}

/// Today: "Claude attend", then "En retard", then the rest without header.
/// The first two exist only when not empty; their headers show only when there is more than
/// one group, which is always the case since the rest is always present (it carries the add
/// row: "Sans projet" with today's due date).
fn today_view(conn: &Connection, today: NaiveDate) -> AppResult<ViewModel> {
    let today_str = format_date(today);
    let loaded = rows::load(conn, Filter::All { completed: false })?;
    // `YYYY-MM-DD` strings compare like dates.
    let due = |t: &TaskFacts| {
        t.due_date
            .as_deref()
            .is_some_and(|d| d <= today_str.as_str())
    };
    // Its own Claude only: a child's Claude brings the child, not its parent.
    let mut open: Vec<TaskFacts> =
        dated(&loaded, |t| due(t) || derive::is_active_today(t.own_ring()))
            .into_iter()
            .cloned()
            .collect();
    open.sort_by(today_order);
    let (waiting, others): (Vec<TaskFacts>, Vec<TaskFacts>) = open
        .into_iter()
        .partition(|t| derive::is_claude_waiting(t.ring()));
    let (mut overdue, rest): (Vec<TaskFacts>, Vec<TaskFacts>) = others.into_iter().partition(|t| {
        t.due_date
            .as_deref()
            .is_some_and(|d| d < today_str.as_str())
    });
    overdue.sort_by(overdue_order);
    let to_rows =
        |v: &[TaskFacts]| -> Vec<TaskRow> { v.iter().map(|t| t.to_row(today, true)).collect() };

    let mut groups = Vec::new();
    for (key, tasks) in [
        (GroupKey::TodayWaiting, &waiting),
        (GroupKey::TodayOverdue, &overdue),
    ] {
        if !tasks.is_empty() {
            groups.push(TaskGroup {
                key,
                show_header: true,
                order: None,
                tasks: to_rows(tasks),
                add_target: None,
            });
        }
    }
    // The rest needs its own header once an earlier group would otherwise absorb it.
    let rest_header = !groups.is_empty();
    groups.push(TaskGroup {
        key: GroupKey::TodayRest,
        show_header: rest_header,
        order: None,
        tasks: to_rows(&rest),
        add_target: Some(AddTarget {
            subject_id: None,
            section_id: None,
            due_today: true,
            due_date: None,
        }),
    });
    // A header is only useful when it separates groups.
    if groups.len() == 1 {
        groups[0].show_header = false;
    }
    let completed: Vec<TaskRow> = rows::load(conn, Filter::All { completed: true })?
        .iter()
        .filter(|t| t.completed_on() == Some(today))
        .map(|t| t.to_row(today, true))
        .collect();
    Ok(ViewModel {
        kind: ViewKind::Today,
        subject: None,
        open_count: groups.iter().map(|g| count(&g.tasks)).sum(),
        groups,
        completed,
        today: today_str,
    })
}

/// Ring urgency, then tasks with a due time (ascending) before the others, then subject
/// order (no project first; sidebar order), then position.
fn today_order(a: &TaskFacts, b: &TaskFacts) -> Ordering {
    derive::urgency(a.ring())
        .cmp(&derive::urgency(b.ring()))
        .then_with(|| day_order(a, b))
}

/// "En retard": oldest due date first (like Todoist), then the Today order.
fn overdue_order(a: &TaskFacts, b: &TaskFacts) -> Ordering {
    a.due_date.cmp(&b.due_date).then_with(|| today_order(a, b))
}

/// « Prochainement »: « En retard » first (only
/// when the range starts today or earlier, and not empty), then one group per day of the
/// range, each present even when empty (it carries the day's add row). Open top-level tasks,
/// and dated subtasks on their own day when their parent is not in the same group
/// ([`dated`]); days before today show no tasks. `from`
/// defaults to today, `days` to [`UPCOMING_DAYS`], clamped to 1..=[`UPCOMING_MAX_DAYS`].
fn upcoming(
    conn: &Connection,
    from: Option<&str>,
    days: Option<u32>,
    today: NaiveDate,
) -> AppResult<ViewModel> {
    let from = match from.map(str::trim).filter(|f| !f.is_empty()) {
        None => today,
        Some(f) => NaiveDate::parse_from_str(f, "%Y-%m-%d")
            .ok()
            .filter(|d| format_date(*d) == f)
            .ok_or_else(|| AppError::Invalid(format!("from must be YYYY-MM-DD: {f}")))?,
    };
    let days = days.unwrap_or(UPCOMING_DAYS).clamp(1, UPCOMING_MAX_DAYS);
    let today_str = format_date(today);
    let open = rows::load(conn, Filter::All { completed: false })?;
    let to_rows = |mut tasks: Vec<&TaskFacts>, order: fn(&TaskFacts, &TaskFacts) -> Ordering| {
        tasks.sort_by(|a, b| order(a, b));
        tasks
            .into_iter()
            .map(|t| t.to_row(today, true))
            .collect::<Vec<TaskRow>>()
    };

    let mut groups = Vec::new();
    if from <= today {
        let overdue = dated(&open, |t| {
            t.due_date
                .as_deref()
                .is_some_and(|d| d < today_str.as_str())
        });
        if !overdue.is_empty() {
            groups.push(TaskGroup {
                key: GroupKey::TodayOverdue,
                show_header: true,
                order: None,
                tasks: to_rows(overdue, |a, b| {
                    a.due_date.cmp(&b.due_date).then_with(|| day_order(a, b))
                }),
                add_target: None,
            });
        }
    }
    for date in (0..u64::from(days)).filter_map(|i| from.checked_add_days(chrono::Days::new(i))) {
        let date_str = format_date(date);
        let tasks: Vec<&TaskFacts> = if date < today {
            Vec::new()
        } else {
            dated(&open, |t| t.due_date.as_deref() == Some(date_str.as_str()))
        };
        groups.push(TaskGroup {
            key: GroupKey::Day {
                date: date_str.clone(),
            },
            show_header: true,
            order: None,
            tasks: to_rows(tasks, day_order),
            add_target: Some(AddTarget {
                subject_id: None,
                section_id: None,
                due_today: date == today,
                due_date: Some(date_str),
            }),
        });
    }
    Ok(ViewModel {
        kind: ViewKind::Upcoming,
        subject: None,
        open_count: groups.iter().map(|g| count(&g.tasks)).sum(),
        groups,
        completed: Vec::new(),
        today: today_str,
    })
}

/// « À faire »: every open top-level task whatever its project, one
/// group per project that has some, in sidebar order (each top-level project followed by its
/// sub-projects), « Sans projet » at its place among the top-level projects
/// (`top_level::order`, last until moved). Within a project, like the project view: tasks
/// outside sections first, then each section in order, by position. Subtasks are nested in
/// their parent; `completed` is empty (like « Prochainement »). Every group carries its
/// `order` (index in its level) so that the UI can drag it by its header.
fn all_view(conn: &Connection, today: NaiveDate) -> AppResult<ViewModel> {
    let open = rows::load(conn, Filter::All { completed: false })?;
    let section_positions: HashMap<String, f64> = {
        let mut stmt = conn.prepare("SELECT id, position FROM sections")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let section_pos = |t: &TaskFacts| {
        t.section_id.as_ref().map_or(f64::NEG_INFINITY, |s| {
            section_positions.get(s).copied().unwrap_or(f64::INFINITY)
        })
    };
    let mut by_subject: HashMap<Option<String>, Vec<&TaskFacts>> = HashMap::new();
    for t in &open {
        by_subject
            .entry(t.subject.as_ref().map(|s| s.id.clone()))
            .or_default()
            .push(t);
    }
    let to_rows = |mut tasks: Vec<&TaskFacts>| -> Vec<TaskRow> {
        tasks.sort_by(|a, b| {
            section_pos(a)
                .total_cmp(&section_pos(b))
                .then_with(|| a.section_id.cmp(&b.section_id))
                .then_with(|| a.position.total_cmp(&b.position))
                .then_with(|| a.id.cmp(&b.id))
        });
        // The group header names the project: rows (and their subtasks) carry no tag, as
        // the contract says `subject` is for Today only.
        tasks.into_iter().map(|t| t.to_row(today, false)).collect()
    };

    let inbox_index = top_level::inbox_index(conn)?;
    let mut inbox_tasks = by_subject.remove(&None);
    let mut inbox_group = |groups: &mut Vec<TaskGroup>| {
        if let Some(tasks) = inbox_tasks.take() {
            groups.push(TaskGroup {
                key: GroupKey::NoProject,
                show_header: true,
                order: Some(GroupOrder {
                    parent_id: None,
                    index: inbox_index,
                }),
                tasks: to_rows(tasks),
                add_target: Some(AddTarget {
                    subject_id: None,
                    section_id: None,
                    due_today: false,
                    due_date: None,
                }),
            });
        }
    };

    let mut groups = Vec::new();
    // Top-level projects passed (shown or not), and whether « Sans projet »'s slot was.
    let mut top_seen: u32 = 0;
    let mut inbox_passed = false;
    let mut children_seen: HashMap<String, u32> = HashMap::new();
    for entry in subjects::entries(conn)? {
        let order = match &entry.parent_id {
            None => {
                if !inbox_passed && top_seen == inbox_index {
                    inbox_group(&mut groups);
                    inbox_passed = true;
                }
                let index = top_seen + u32::from(inbox_passed);
                top_seen += 1;
                GroupOrder {
                    parent_id: None,
                    index,
                }
            }
            Some(parent) => {
                let seen = children_seen.entry(parent.clone()).or_default();
                let index = *seen;
                *seen += 1;
                GroupOrder {
                    parent_id: Some(parent.clone()),
                    index,
                }
            }
        };
        let Some(tasks) = by_subject.remove(&Some(entry.id.clone())) else {
            continue;
        };
        groups.push(TaskGroup {
            add_target: Some(AddTarget {
                subject_id: Some(entry.id.clone()),
                section_id: None,
                due_today: false,
                due_date: None,
            }),
            key: GroupKey::Project {
                id: entry.id,
                name: entry.name,
                color: entry.color,
                parent_name: entry.parent_name,
            },
            show_header: true,
            order: Some(order),
            tasks: to_rows(tasks),
        });
    }
    inbox_group(&mut groups);
    Ok(ViewModel {
        kind: ViewKind::All,
        subject: None,
        open_count: groups.iter().map(|g| count(&g.tasks)).sum(),
        groups,
        completed: Vec::new(),
        today: format_date(today),
    })
}

/// Within a day: tasks with a due time (ascending) before the others, then subject order
/// (no project first; sidebar order), then position.
fn day_order(a: &TaskFacts, b: &TaskFacts) -> Ordering {
    match (&a.due_time, &b.due_time) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
    .then_with(|| {
        // Sidebar order: a sub-project right after its parent.
        let pos = |t: &TaskFacts| {
            let (top, sub) = t.subject_order.unwrap_or((f64::NEG_INFINITY, None));
            (top, sub.unwrap_or(f64::NEG_INFINITY))
        };
        let ((ta, sa), (tb, sb)) = (pos(a), pos(b));
        ta.total_cmp(&tb).then_with(|| sa.total_cmp(&sb))
    })
    .then_with(|| a.position.total_cmp(&b.position))
    .then_with(|| a.id.cmp(&b.id))
}

/// Project: tasks outside sections first, without header (always present,
/// it carries the project's add row), then each section in order with its header.
fn subject_view(conn: &Connection, subject_id: &str, today: NaiveDate) -> AppResult<ViewModel> {
    let subject = subjects::get(conn, subject_id)?;
    let open = rows::load(
        conn,
        Filter::Subject {
            id: subject_id,
            completed: false,
        },
    )?;
    let completed = rows::load(
        conn,
        Filter::Subject {
            id: subject_id,
            completed: true,
        },
    )?;
    let in_section = |section: Option<&str>| -> Vec<TaskRow> {
        open.iter()
            .filter(|t| t.section_id.as_deref() == section)
            .map(|t| t.to_row(today, false))
            .collect()
    };

    let mut groups = vec![TaskGroup {
        key: GroupKey::NoSection,
        show_header: false,
        order: None,
        tasks: in_section(None),
        add_target: Some(AddTarget {
            subject_id: Some(subject.id.clone()),
            section_id: None,
            due_today: false,
            due_date: None,
        }),
    }];
    for section in &subject.sections {
        groups.push(TaskGroup {
            key: GroupKey::Section {
                id: section.id.clone(),
                name: section.name.clone(),
                subpath: section.subpath.clone(),
            },
            show_header: true,
            order: None,
            tasks: in_section(Some(&section.id)),
            add_target: Some(AddTarget {
                subject_id: Some(subject.id.clone()),
                section_id: Some(section.id.clone()),
                due_today: false,
                due_date: None,
            }),
        });
    }
    Ok(ViewModel {
        kind: ViewKind::Subject,
        open_count: groups.iter().map(|g| count(&g.tasks)).sum(),
        subject: Some(subject),
        groups,
        completed: completed.iter().map(|t| t.to_row(today, false)).collect(),
        today: format_date(today),
    })
}

fn count(rows: &[TaskRow]) -> u32 {
    u32::try_from(rows.len()).unwrap_or(u32::MAX)
}

fn format_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}
