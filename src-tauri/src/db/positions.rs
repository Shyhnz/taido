//! Real-number positions: append = max + 1, insertion = midpoint of the neighbours,
//! renumbering of the scope (1, 2, 3…) when the gap between neighbours falls under 1e-6.

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};

use crate::error::AppResult;

/// Below this gap, the scope is renumbered before inserting.
pub const MIN_GAP: f64 = 1e-6;

/// A set of siblings sharing one ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope<'a> {
    /// Top-level subjects (`parent_id: None`) or the sub-projects of one.
    Subjects { parent_id: Option<&'a str> },
    /// Sections of a subject.
    Sections { subject_id: &'a str },
    /// Top-level tasks of a place: `subject_id: None` = inbox, `section_id: None` = "Sans
    /// section". Child tasks are ordered under their parent instead.
    Tasks {
        subject_id: Option<&'a str>,
        section_id: Option<&'a str>,
    },
    /// Subtasks of a task: its child tasks.
    Subtasks { task_id: &'a str },
    /// Note groups of a project's notebook.
    NoteGroups { subject_id: &'a str },
    /// Live, unpinned pages of a notebook group. Outside any group (`group_id: None`) the
    /// plain pages and the summaries (`summaries`) are two separate lists.
    NotePages {
        subject_id: &'a str,
        group_id: Option<&'a str>,
        summaries: bool,
    },
}

impl Scope<'_> {
    fn table(&self) -> &'static str {
        match self {
            Scope::Subjects { .. } => "subjects",
            Scope::Sections { .. } => "sections",
            Scope::Tasks { .. } => "tasks",
            Scope::Subtasks { .. } => "tasks",
            Scope::NoteGroups { .. } => "note_groups",
            Scope::NotePages { .. } => "note_pages",
        }
    }

    /// `WHERE` clause (without the keyword) and its parameters. `IS` matches NULL too.
    fn filter(&self) -> (&'static str, Vec<Value>) {
        let text = |s: &str| Value::Text(s.to_string());
        let opt = |s: Option<&str>| s.map_or(Value::Null, text);
        match *self {
            Scope::Subjects { parent_id } => ("parent_id IS ?", vec![opt(parent_id)]),
            Scope::Sections { subject_id } => ("subject_id = ?", vec![text(subject_id)]),
            Scope::Tasks {
                subject_id,
                section_id,
            } => (
                "subject_id IS ? AND section_id IS ? AND parent_id IS NULL",
                vec![opt(subject_id), opt(section_id)],
            ),
            Scope::Subtasks { task_id } => ("parent_id = ?", vec![text(task_id)]),
            Scope::NoteGroups { subject_id } => ("subject_id = ?", vec![text(subject_id)]),
            Scope::NotePages {
                subject_id,
                group_id: Some(group_id),
                ..
            } => (
                "subject_id = ? AND group_id = ? AND pinned_at IS NULL AND deleted_at IS NULL",
                vec![text(subject_id), text(group_id)],
            ),
            Scope::NotePages {
                subject_id,
                group_id: None,
                summaries,
            } => (
                "subject_id = ? AND group_id IS NULL AND kind = ? AND pinned_at IS NULL \
                 AND deleted_at IS NULL",
                vec![
                    text(subject_id),
                    text(if summaries { "summary" } else { "page" }),
                ],
            ),
        }
    }

    /// Restriction of the siblings an index refers to (what the UI shows): tasks and
    /// subtasks are reordered among open, live tasks (completed subtasks come after the open
    /// ones), subjects among live subjects, the other scopes among all their rows.
    /// Soft-deleted rows keep their position for a restore.
    fn visible(&self) -> &'static str {
        match self {
            Scope::Tasks { .. } | Scope::Subtasks { .. } => {
                " AND completed_at IS NULL AND deleted_at IS NULL"
            }
            Scope::Subjects { .. } => " AND deleted_at IS NULL",
            _ => "",
        }
    }
}

/// Position at the end of the scope: max + 1 (1 for an empty scope).
pub fn append(conn: &Connection, scope: Scope<'_>) -> AppResult<f64> {
    let (filter, params) = scope.filter();
    let sql = format!("SELECT MAX(position) FROM {} WHERE {filter}", scope.table());
    let max: Option<f64> = conn.query_row(&sql, params_from_iter(params), |r| r.get(0))?;
    Ok(max.map_or(1.0, |m| m + 1.0))
}

/// Position that puts an item at `index` among its siblings (0 = first), the item `moving`
/// being excluded from the siblings. Past the end = append.
pub fn at_index(
    conn: &Connection,
    scope: Scope<'_>,
    moving: Option<&str>,
    index: usize,
) -> AppResult<f64> {
    for _ in 0..2 {
        let siblings = sibling_positions(conn, scope, moving)?;
        if index >= siblings.len() {
            return append(conn, scope);
        }
        let next = siblings[index];
        if index == 0 {
            return Ok(next - 1.0);
        }
        let prev = siblings[index - 1];
        if next - prev >= MIN_GAP {
            return Ok(midpoint(prev, next));
        }
        renumber(conn, scope)?;
    }
    // After a renumbering every gap is at least 1: unreachable in practice.
    append(conn, scope)
}

/// Position right after `after` within the scope, whatever the completion state of the rows.
pub fn after(conn: &Connection, scope: Scope<'_>, after_id: &str) -> AppResult<f64> {
    for _ in 0..2 {
        let (filter, mut params) = scope.filter();
        let table = scope.table();
        params.push(Value::Text(after_id.to_string()));
        let sql = format!(
            "SELECT position, (SELECT MIN(position) FROM {table} WHERE {filter} \
             AND position > base.position) \
             FROM {table} AS base WHERE base.id = ?"
        );
        // The filter appears once in the sub-query: its parameters come first.
        let (pos, next): (f64, Option<f64>) =
            conn.query_row(&sql, params_from_iter(params), |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        match next {
            None => return Ok(pos + 1.0),
            Some(next) if next - pos >= MIN_GAP => return Ok(midpoint(pos, next)),
            Some(_) => renumber(conn, scope)?,
        }
    }
    append(conn, scope)
}

/// Rewrites the positions of the scope as 1, 2, 3… keeping the current order.
pub fn renumber(conn: &Connection, scope: Scope<'_>) -> AppResult<()> {
    let (filter, params) = scope.filter();
    let table = scope.table();
    let sql = format!("SELECT id FROM {table} WHERE {filter} ORDER BY position, id");
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(params), |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let update = format!("UPDATE {table} SET position = ?1 WHERE id = ?2");
    let mut stmt = conn.prepare(&update)?;
    for (i, id) in ids.iter().enumerate() {
        stmt.execute(rusqlite::params![(i + 1) as f64, id])?;
    }
    log::debug!("renumbered {} rows of {table}", ids.len());
    Ok(())
}

fn sibling_positions(
    conn: &Connection,
    scope: Scope<'_>,
    moving: Option<&str>,
) -> AppResult<Vec<f64>> {
    let (filter, mut params) = scope.filter();
    params.push(moving.map_or(Value::Null, |m| Value::Text(m.to_string())));
    let sql = format!(
        "SELECT position FROM {} WHERE {filter}{} AND id IS NOT ? ORDER BY position, id",
        scope.table(),
        scope.visible()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params), |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn midpoint(a: f64, b: f64) -> f64 {
    a + (b - a) / 2.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    const TOP: Scope<'static> = Scope::Subjects { parent_id: None };

    fn insert_subject(conn: &Connection, id: &str, position: f64) {
        conn.execute(
            "INSERT INTO subjects (id, name, color, root_path, position, created_at, updated_at) \
             VALUES (?1, ?1, 'violet', '/tmp', ?2, 'x', 'x')",
            rusqlite::params![id, position],
        )
        .expect("insert");
    }

    fn order(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT id FROM subjects ORDER BY position, id")
            .expect("prepare");
        let rows = stmt.query_map([], |r| r.get(0)).expect("query");
        rows.collect::<Result<_, _>>().expect("rows")
    }

    #[test]
    fn append_starts_at_one_then_max_plus_one() {
        let conn = open_in_memory().expect("db");
        assert_eq!(append(&conn, TOP).expect("append"), 1.0);
        insert_subject(&conn, "a", 4.5);
        assert_eq!(append(&conn, TOP).expect("append"), 5.5);
    }

    #[test]
    fn at_index_cases() {
        // (index, moving, expected position) with siblings a=1, b=2, c=3.
        let cases: &[(usize, Option<&str>, f64)] = &[
            (0, None, 0.0),
            (1, None, 1.5),
            (2, None, 2.5),
            (3, None, 4.0),
            (99, None, 4.0),
            (0, Some("a"), 1.0),
            (1, Some("a"), 2.5),
            (1, Some("c"), 1.5),
        ];
        let conn = open_in_memory().expect("db");
        insert_subject(&conn, "a", 1.0);
        insert_subject(&conn, "b", 2.0);
        insert_subject(&conn, "c", 3.0);
        for &(index, moving, expected) in cases {
            let got = at_index(&conn, TOP, moving, index).expect("at_index");
            assert_eq!(got, expected, "index {index}, moving {moving:?}");
        }
    }

    #[test]
    fn renumbers_when_gap_is_too_small() {
        let conn = open_in_memory().expect("db");
        insert_subject(&conn, "a", 1.0);
        insert_subject(&conn, "b", 1.0 + 1e-9);
        insert_subject(&conn, "c", 7.0);
        let pos = at_index(&conn, TOP, None, 1).expect("at_index");
        assert_eq!(pos, 1.5);
        let positions: Vec<f64> = {
            let mut stmt = conn
                .prepare("SELECT position FROM subjects ORDER BY position")
                .expect("prepare");
            let rows = stmt.query_map([], |r| r.get(0)).expect("query");
            rows.collect::<Result<_, _>>().expect("rows")
        };
        assert_eq!(positions, vec![1.0, 2.0, 3.0]);
        assert_eq!(order(&conn), vec!["a", "b", "c"]);
    }

    #[test]
    fn repeated_insertions_keep_order_through_renumbering() {
        let conn = open_in_memory().expect("db");
        insert_subject(&conn, "first", 1.0);
        insert_subject(&conn, "last", 2.0);
        // Always insert right after "first": the gap halves until renumbering kicks in.
        let mut expected = vec!["first".to_string()];
        let mut inserted = Vec::new();
        for i in 0..60 {
            let id = format!("n{i:02}");
            let pos = at_index(&conn, TOP, None, 1).expect("at_index");
            insert_subject(&conn, &id, pos);
            inserted.insert(0, id);
        }
        expected.extend(inserted);
        expected.push("last".to_string());
        assert_eq!(order(&conn), expected);
    }

    #[test]
    fn after_places_between_item_and_next() {
        let conn = open_in_memory().expect("db");
        insert_subject(&conn, "a", 1.0);
        insert_subject(&conn, "b", 2.0);
        assert_eq!(after(&conn, TOP, "a").expect("after"), 1.5);
        assert_eq!(after(&conn, TOP, "b").expect("after"), 3.0);
        insert_subject(&conn, "c", 1.0 + 1e-9);
        let pos = after(&conn, TOP, "a").expect("after");
        assert_eq!(pos, 1.5);
        assert_eq!(order(&conn), vec!["a", "c", "b"]);
    }
}
