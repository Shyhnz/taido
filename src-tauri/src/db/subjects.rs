//! Subjects repository ("Projets" in the UI, D1).
//!
//! A project may hold sub-projects, one level only. A sub-project
//! names its parent (`parent_id`), is ordered among its siblings, uses its parent's folder
//! when it has none, and is deleted and restored with its parent.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::positions::{self, Scope};
use crate::db::top_level::{self, TopItem};
use crate::db::{new_id, non_empty, now_utc, sections};
use crate::error::{AppError, AppResult};
use crate::i18n;
use crate::model::{CreateSubjectInput, ReorderInput, Subject, SubjectColor, UpdateSubjectInput};
use crate::views;

const COLUMNS: &str = concat!(
    "id, name, color, root_path, position, \
     (SELECT COUNT(*) FROM tasks t WHERE t.subject_id = subjects.id \
     AND t.completed_at IS NULL AND t.deleted_at IS NULL AND ",
    crate::db::listed_open_sql!(),
    "), parent_id, is_group"
);

/// Name of a group created without one, as the French tests see it (their language is pinned).
#[cfg(test)]
pub const NEW_GROUP_NAME: &str = "Nouveau groupe";

pub fn create(conn: &Connection, input: &CreateSubjectInput) -> AppResult<Subject> {
    let name = non_empty(&input.name, "subject name")?;
    let root_path = match &input.root_path {
        Some(p) => validate_root_path(p)?,
        None => None,
    };
    let parent_id = match input.parent_id.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(p) => {
            ensure_group(conn, p)?;
            Some(p.to_string())
        }
    };
    let id = new_id();
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let color = match input.color {
        Some(c) => c,
        None => next_color(&tx)?,
    };
    let position = append_position(&tx, parent_id.as_deref())?;
    tx.execute(
        "INSERT INTO subjects (id, name, color, root_path, position, created_at, updated_at, \
         parent_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![
            id,
            name,
            color.as_str(),
            root_path,
            position,
            now,
            parent_id
        ],
    )?;
    tx.commit()?;
    // Every project gets its folder (by design): in the app's folder, or its parent's.
    if let Err(e) = crate::db::workspace::ensure_project_folder(conn, &id) {
        log::warn!("cannot create the folder of project {id}: {e}");
    }
    get(conn, &id)
}

/// Palette color after the one of the most recently created subject (deleted ones
/// included, so that undoing a deletion does not shift the rotation); first color if none.
pub fn next_color(conn: &Connection) -> AppResult<SubjectColor> {
    let last: Option<String> = conn
        .query_row(
            "SELECT color FROM subjects ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match last.as_deref().and_then(SubjectColor::parse) {
        Some(c) => c.next(),
        None => SubjectColor::PALETTE[0],
    })
}

/// A live (not deleted) subject. Its dot includes its sub-projects' tasks.
pub fn get(conn: &Connection, id: &str) -> AppResult<Subject> {
    let sql = format!("SELECT {COLUMNS} FROM subjects WHERE id = ?1 AND deleted_at IS NULL");
    let mut subject = conn
        .query_row(&sql, [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("subject {id}")))?;
    subject.dot = views::subject_dot(conn, id)?;
    with_sections(conn, subject)
}

/// Flat, in sidebar order: top-level subjects by position, each followed by its
/// sub-projects by position.
pub fn list(conn: &Connection) -> AppResult<Vec<Subject>> {
    let sql =
        format!("SELECT {COLUMNS} FROM subjects WHERE deleted_at IS NULL ORDER BY position, id");
    let subjects: Vec<Subject> = {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], from_row)?;
        rows.collect::<Result<_, _>>()?
    };
    let subjects = sidebar_order(subjects, |s| (s.id.as_str(), s.parent_id.as_deref()));
    let mut dots = views::subject_dots(conn)?;
    subjects
        .into_iter()
        .map(|mut s| {
            s.dot = dots.remove(&s.id);
            with_sections(conn, s)
        })
        .collect()
}

/// What a multi-project view needs to know about a live subject.
#[derive(Debug, Clone, PartialEq)]
pub struct SubjectEntry {
    pub id: String,
    pub name: String,
    pub color: SubjectColor,
    /// Parent, for a sub-project.
    pub parent_id: Option<String>,
    /// Name of the parent, for a sub-project.
    pub parent_name: Option<String>,
}

/// Live subjects in sidebar order (see [`list`]), without sections, counts nor dots.
pub fn entries(conn: &Connection) -> AppResult<Vec<SubjectEntry>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.name, s.color, s.parent_id, p.name FROM subjects s \
         LEFT JOIN subjects p ON p.id = s.parent_id \
         WHERE s.deleted_at IS NULL ORDER BY s.position, s.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SubjectEntry {
            id: r.get(0)?,
            name: r.get(1)?,
            color: parse_color(&r.get::<_, String>(2)?),
            parent_id: r.get(3)?,
            parent_name: r.get(4)?,
        })
    })?;
    let rows: Vec<SubjectEntry> = rows.collect::<Result<_, _>>()?;
    Ok(sidebar_order(rows, |e| {
        (e.id.as_str(), e.parent_id.as_deref())
    }))
}

/// Reorders items already sorted by position: each top-level item followed by its children
/// (in their given order). Children whose parent is not among the items come last.
fn sidebar_order<T>(items: Vec<T>, ids: impl Fn(&T) -> (&str, Option<&str>)) -> Vec<T> {
    let mut tops = Vec::new();
    let mut children: BTreeMap<String, Vec<T>> = BTreeMap::new();
    for item in items {
        match ids(&item).1.map(String::from) {
            None => tops.push(item),
            Some(parent) => children.entry(parent).or_default().push(item),
        }
    }
    let mut ordered = Vec::new();
    for top in tops {
        let kids = children.remove(ids(&top).0);
        ordered.push(top);
        ordered.extend(kids.into_iter().flatten());
    }
    ordered.extend(children.into_values().flatten());
    ordered
}

/// Parent of every live sub-project: sub-project id → parent id.
pub fn parents(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id FROM subjects WHERE parent_id IS NOT NULL AND deleted_at IS NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Live sub-projects of a subject, by position.
pub fn child_ids(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM subjects WHERE parent_id = ?1 AND deleted_at IS NULL \
         ORDER BY position, id",
    )?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Folder the tasks of `subject` work in: its own, else its parent's (a sub-project without
/// folder uses its parent's). `None` when neither has one.
pub fn effective_root(conn: &Connection, subject: &Subject) -> AppResult<Option<String>> {
    if subject.root_path.is_some() {
        return Ok(subject.root_path.clone());
    }
    let Some(parent) = &subject.parent_id else {
        return Ok(None);
    };
    // A group is only visual (Taido V2.2 bis): its folder is never its projects'.
    let root: Option<Option<String>> = conn
        .query_row(
            "SELECT root_path FROM subjects WHERE id = ?1 AND is_group = 0",
            [parent],
            |r| r.get(0),
        )
        .optional()?;
    Ok(root.flatten())
}

/// « Parent › Projet » for a sub-project, else the project's name.
pub fn label(conn: &Connection, id: &str) -> AppResult<String> {
    let subject = get(conn, id)?;
    let parent = match &subject.parent_id {
        Some(p) => Some(get(conn, p)?.name),
        None => None,
    };
    Ok(match parent {
        Some(parent) => format!("{parent} › {}", subject.name),
        None => subject.name,
    })
}

/// Longest folder name made from a project name, in bytes (see [`folder_name`]).
pub const FOLDER_NAME_MAX_BYTES: usize = 200;

/// Folder name for a project: its name without path separators nor leading dots, cut to
/// [`FOLDER_NAME_MAX_BYTES`]. On Windows, also without the characters it forbids in file
/// names nor trailing dots.
pub fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            let forbidden_on_windows =
                cfg!(windows) && (matches!(c, '<' | '>' | '"' | '|' | '?' | '*') || c.is_control());
            if matches!(c, '/' | '\\' | ':' | '\0') || forbidden_on_windows {
                '-'
            } else {
                c
            }
        })
        .collect();
    let mut cleaned = cleaned.trim_start_matches('.').trim();
    if cfg!(windows) {
        cleaned = cleaned.trim_end_matches(['.', ' ']);
    }
    // macOS refuses path components over 255 bytes; names typed on the phone are unlimited
    //. Cut on a character boundary.
    let mut end = cleaned.len().min(FOLDER_NAME_MAX_BYTES);
    while !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    let cleaned = cleaned[..end].trim_end().to_string();
    if cleaned.is_empty() {
        "project".to_string()
    } else {
        cleaned
    }
}

/// `parent_id`: `None` keeps the parent, `Some("")` makes the subject a top-level project,
/// else it becomes a sub-project of that top-level project (one level: not itself, and
/// only when it has no sub-projects). A move puts it last among its new siblings.
pub fn update(conn: &Connection, input: &UpdateSubjectInput) -> AppResult<Subject> {
    let current = get(conn, &input.id)?;
    let name = match &input.name {
        Some(n) => non_empty(n, "subject name")?,
        None => current.name,
    };
    let root_path = match &input.root_path {
        Some(p) => validate_root_path(p)?,
        None => current.root_path,
    };
    let color = input.color.unwrap_or(current.color);
    let parent_id = match input.parent_id.as_deref().map(str::trim) {
        None => current.parent_id.clone(),
        Some("") => None,
        Some(p) => {
            if p == input.id {
                return Err(AppError::Invalid(
                    "a project cannot be its own sub-project".into(),
                ));
            }
            ensure_group(conn, p)?;
            if current.is_group {
                return Err(AppError::Invalid("a group cannot go into a group".into()));
            }
            Some(p.to_string())
        }
    };
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    if parent_id != current.parent_id {
        let position = append_position(&tx, parent_id.as_deref())?;
        tx.execute(
            "UPDATE subjects SET parent_id = ?2, position = ?3 WHERE id = ?1",
            params![input.id, parent_id, position],
        )?;
    }
    tx.execute(
        "UPDATE subjects SET name = ?2, color = ?3, root_path = ?4, updated_at = ?5 WHERE id = ?1",
        params![input.id, name, color.as_str(), root_path, now],
    )?;
    tx.commit()?;
    // Moved under a parent (or unlinked) without folder: its own folder in the parent's.
    if let Err(e) = crate::db::workspace::ensure_project_folder(conn, &input.id) {
        log::warn!("cannot create the folder of project {}: {e}", input.id);
    }
    // A parent just linked to a folder: its sub-projects get theirs at once.
    for child in child_ids(conn, &input.id)? {
        if let Err(e) = crate::db::workspace::ensure_project_folder(conn, &child) {
            log::warn!("cannot create the folder of sub-project {child}: {e}");
        }
    }
    get(conn, &input.id)
}

/// Soft-deletes the subject and its live sub-projects, and stamps their live tasks with the
/// same instant (see `trash`).
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let n = tx.execute(
        "UPDATE subjects SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("subject {id}")));
    }
    tx.execute(
        "UPDATE subjects SET deleted_at = ?2 WHERE parent_id = ?1 AND deleted_at IS NULL",
        params![id, now],
    )?;
    tx.execute(
        "UPDATE tasks SET deleted_at = ?2 WHERE deleted_at IS NULL AND subject_id IN \
         (SELECT id FROM subjects WHERE (id = ?1 OR parent_id = ?1) AND deleted_at = ?2)",
        params![id, now],
    )?;
    tx.commit()?;
    Ok(())
}

/// Undoes [`delete`]: the subject, the sub-projects and the tasks deleted with it come back.
/// A sub-project comes back under its parent only if the parent is live (else `NotFound`);
/// if the parent has become a sub-project since, it comes back as a top-level project
/// (one level only), last.
pub fn restore(conn: &Connection, id: &str) -> AppResult<Subject> {
    let found: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT deleted_at, parent_id FROM subjects WHERE id = ?1 AND deleted_at IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (deleted_at, parent_id) =
        found.ok_or_else(|| AppError::NotFound(format!("deleted subject {id}")))?;
    let to_top_level = match &parent_id {
        None => false,
        Some(parent) => {
            let grand_parent: Option<Option<String>> = conn
                .query_row(
                    "SELECT parent_id FROM subjects WHERE id = ?1 AND deleted_at IS NULL",
                    [parent],
                    |r| r.get(0),
                )
                .optional()?;
            grand_parent
                .ok_or_else(|| AppError::NotFound(format!("subject {parent}")))?
                .is_some()
        }
    };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE tasks SET deleted_at = NULL WHERE deleted_at = ?2 AND subject_id IN \
         (SELECT id FROM subjects WHERE (id = ?1 OR parent_id = ?1) AND deleted_at = ?2)",
        params![id, deleted_at],
    )?;
    tx.execute(
        "UPDATE subjects SET deleted_at = NULL \
         WHERE (id = ?1 OR parent_id = ?1) AND deleted_at = ?2",
        params![id, deleted_at],
    )?;
    if to_top_level {
        let position = append_position(&tx, None)?;
        tx.execute(
            "UPDATE subjects SET parent_id = NULL, position = ?2 WHERE id = ?1",
            params![id, position],
        )?;
    }
    tx.commit()?;
    get(conn, id)
}

/// Position that puts a subject last among its new siblings: after everything at the top
/// level (« Sans projet » included once placed, `top_level`), else after the parent's
/// sub-projects.
pub fn append_position(conn: &Connection, parent_id: Option<&str>) -> AppResult<f64> {
    match parent_id {
        None => top_level::append_position(conn),
        Some(parent) => positions::append(
            conn,
            Scope::Subjects {
                parent_id: Some(parent),
            },
        ),
    }
}

/// Moves the subject among its siblings. At the top level, `index` is an index in
/// `top_level::order`: « Sans projet » counts, shown in the UI or not. A sub-project moves
/// among the live sub-projects of its parent. Renumbering (if any) and the update share one
/// transaction.
pub fn reorder(conn: &Connection, input: &ReorderInput) -> AppResult<()> {
    let parent_id = parent_of(conn, &input.id)?;
    if parent_id.is_none() {
        return top_level::reorder(
            conn,
            &TopItem::Subject(input.id.clone()),
            input.index as usize,
        );
    }
    let tx = conn.unchecked_transaction()?;
    let position = positions::at_index(
        &tx,
        Scope::Subjects {
            parent_id: parent_id.as_deref(),
        },
        Some(&input.id),
        input.index as usize,
    )?;
    tx.execute(
        "UPDATE subjects SET position = ?2, updated_at = ?3 WHERE id = ?1",
        params![input.id, position, now_utc()],
    )?;
    tx.commit()?;
    Ok(())
}

/// The subject exists and is not deleted.
pub fn ensure_exists(conn: &Connection, id: &str) -> AppResult<()> {
    parent_of(conn, id).map(|_| ())
}

/// Parent of a live subject (`None` for a top-level one); `NotFound` if it is not live.
fn parent_of(conn: &Connection, id: &str) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT parent_id FROM subjects WHERE id = ?1 AND deleted_at IS NULL",
        [id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("subject {id}")))
}

/// `id` is a live group (else `NotFound` or `Invalid`): the only subject projects go into.
fn ensure_group(conn: &Connection, id: &str) -> AppResult<()> {
    if !get(conn, id)?.is_group {
        return Err(AppError::Invalid(format!("subject {id} is not a group")));
    }
    Ok(())
}

/// A live project that can hold tasks and sections: not a group (Taido V2.2 bis).
pub fn ensure_project(conn: &Connection, id: &str) -> AppResult<()> {
    if get(conn, id)?.is_group {
        return Err(AppError::Invalid(format!(
            "subject {id} is a group: it holds no tasks"
        )));
    }
    Ok(())
}

/// Top-level position just after `group`, before the next top-level item: where projects
/// leaving it go, in order. Returns one position per project.
fn slots_after(conn: &Connection, group: &Subject, n: usize) -> AppResult<Vec<f64>> {
    let mut next: Option<f64> = conn
        .query_row(
            "SELECT MIN(position) FROM subjects WHERE parent_id IS NULL \
             AND deleted_at IS NULL AND position > ?1",
            [group.position],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(inbox) = crate::db::synced_settings::inbox_position(conn)? {
        if inbox > group.position && next.is_none_or(|p| inbox < p) {
            next = Some(inbox);
        }
    }
    let end = next.unwrap_or(group.position + n as f64 + 1.0);
    let step = (end - group.position) / (n as f64 + 1.0);
    Ok((1..=n).map(|i| group.position + step * i as f64).collect())
}

/// « Ajouter les projets à un groupe » (Taido V2.2 bis). A new group takes the place of the
/// first project. Groups left empty disappear, like Brave's. Returns the group's id.
pub fn group_projects(
    conn: &Connection,
    input: &crate::model::GroupProjectsInput,
) -> AppResult<String> {
    let projects: Vec<Subject> = input
        .project_ids
        .iter()
        .map(|id| get(conn, id))
        .collect::<AppResult<_>>()?;
    let Some(first) = projects.first() else {
        return Err(AppError::Invalid("no project to group".into()));
    };
    if projects.iter().any(|p| p.is_group) {
        return Err(AppError::Invalid("a group cannot go into a group".into()));
    }
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let group_id = match &input.group_id {
        Some(g) => {
            ensure_group(&tx, g)?;
            g.clone()
        }
        None => {
            let name = input
                .name
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(i18n::new_group(i18n::current_language(&tx)));
            // The group takes the first project's place in the sidebar.
            let position = match &first.parent_id {
                Some(g) => get(&tx, g)?.position,
                None => first.position,
            };
            let id = new_id();
            tx.execute(
                "INSERT INTO subjects (id, name, color, root_path, position, created_at, \
                 updated_at, parent_id, is_group) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5, NULL, 1)",
                params![id, name, next_color(&tx)?.as_str(), position, now],
            )?;
            id
        }
    };
    let old_groups: Vec<String> = projects
        .iter()
        .filter_map(|p| p.parent_id.clone())
        .filter(|g| *g != group_id)
        .collect();
    for p in &projects {
        if p.parent_id.as_deref() == Some(group_id.as_str()) {
            continue;
        }
        let position = append_position(&tx, Some(&group_id))?;
        tx.execute(
            "UPDATE subjects SET parent_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
            params![p.id, group_id, position, now],
        )?;
    }
    for g in old_groups {
        if child_ids(&tx, &g)?.is_empty() {
            tx.execute(
                "UPDATE subjects SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                params![g, now],
            )?;
        }
    }
    tx.commit()?;
    Ok(group_id)
}

/// « Retirer du groupe »: the projects go back to the top level, just after their group;
/// a group left empty disappears.
pub fn ungroup_projects(conn: &Connection, project_ids: &[String]) -> AppResult<()> {
    let now = now_utc();
    let tx = conn.unchecked_transaction()?;
    let mut by_group: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in project_ids {
        if let Some(g) = get(&tx, id)?.parent_id {
            by_group.entry(g).or_default().push(id.clone());
        }
    }
    for (g, ids) in by_group {
        let group = get(&tx, &g)?;
        for (id, position) in ids.iter().zip(slots_after(&tx, &group, ids.len())?) {
            tx.execute(
                "UPDATE subjects SET parent_id = NULL, position = ?2, updated_at = ?3 \
                 WHERE id = ?1",
                params![id, position, now],
            )?;
        }
        if child_ids(&tx, &g)?.is_empty() {
            tx.execute(
                "UPDATE subjects SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                params![g, now],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// « Dégrouper »: every project of the group goes back to the top level in its place.
pub fn dissolve_group(conn: &Connection, id: &str) -> AppResult<()> {
    ensure_group(conn, id)?;
    let children = child_ids(conn, id)?;
    if children.is_empty() {
        conn.execute(
            "UPDATE subjects SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now_utc()],
        )?;
        return Ok(());
    }
    ungroup_projects(conn, &children)
}

/// Unknown colors (hand-edited database) fall back to gray rather than failing.
pub fn parse_color(s: &str) -> SubjectColor {
    SubjectColor::parse(s).unwrap_or(SubjectColor::Gray)
}

/// Absolute path; an empty string means "no folder" (`None`).
fn validate_root_path(path: &str) -> AppResult<Option<String>> {
    let path = path.trim();
    if path.is_empty() {
        return Ok(None);
    }
    if !Path::new(path).is_absolute() {
        return Err(AppError::Invalid(format!(
            "subject folder must be an absolute path: {path}"
        )));
    }
    Ok(Some(path.to_string()))
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<Subject> {
    Ok(Subject {
        id: r.get(0)?,
        name: r.get(1)?,
        color: parse_color(&r.get::<_, String>(2)?),
        root_path: r.get(3)?,
        position: r.get(4)?,
        sections: Vec::new(),
        open_count: r.get(5)?,
        dot: None,
        parent_id: r.get(6)?,
        is_group: r.get(7)?,
    })
}

fn with_sections(conn: &Connection, mut subject: Subject) -> AppResult<Subject> {
    subject.sections = sections::list_for_subject(conn, &subject.id)?;
    Ok(subject)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::tasks;
    use crate::db::test_support::{backdate_deletion, task};

    fn input(name: &str) -> CreateSubjectInput {
        CreateSubjectInput {
            name: name.into(),
            color: Some(SubjectColor::Teal),
            root_path: Some("/Users/me/projects".into()),
            parent_id: None,
        }
    }

    fn bare(name: &str) -> CreateSubjectInput {
        CreateSubjectInput {
            name: name.into(),
            color: None,
            root_path: None,
            parent_id: None,
        }
    }

    #[test]
    fn create_get_list() {
        let conn = open_in_memory().expect("db");
        let a = create(&conn, &input("  Alpha ")).expect("create");
        let b = create(&conn, &input("Beta")).expect("create");
        assert_eq!(a.name, "Alpha");
        assert_eq!(a.color, SubjectColor::Teal);
        assert_eq!(a.root_path.as_deref(), Some("/Users/me/projects"));
        assert_eq!(a.position, 1.0);
        assert_eq!(b.position, 2.0);
        assert_eq!(a.open_count, 0);
        assert!(a.sections.is_empty());
        assert_eq!(a.dot, None);
        assert_eq!(get(&conn, &a.id).expect("get"), a);
        let names: Vec<_> = list(&conn)
            .expect("list")
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["Alpha", "Beta"]);
    }

    #[test]
    fn create_without_folder_nor_color_rotates_the_palette() {
        let conn = open_in_memory().expect("db");
        let colors: Vec<SubjectColor> = (0..10)
            .map(|i| create(&conn, &bare(&format!("P{i}"))).expect("create"))
            .map(|s| {
                assert_eq!(s.root_path, None);
                s.color
            })
            .collect();
        let mut expected = SubjectColor::PALETTE.to_vec();
        expected.extend_from_slice(&SubjectColor::PALETTE[..2]);
        assert_eq!(colors, expected);
        // An explicit color sets the rotation's starting point.
        create(
            &conn,
            &CreateSubjectInput {
                color: Some(SubjectColor::Indigo),
                ..bare("Explicit")
            },
        )
        .expect("create");
        assert_eq!(
            create(&conn, &bare("After")).expect("create").color,
            SubjectColor::Brown
        );
    }

    #[test]
    fn create_validation() {
        /// (name, folder, expected stored folder or an `Invalid` error)
        type Case<'a> = (&'a str, Option<&'a str>, Result<Option<&'a str>, ()>);
        let cases: &[Case] = &[
            ("Ok", Some("/abs/path"), Ok(Some("/abs/path"))),
            ("Ok", None, Ok(None)),
            ("Ok", Some(""), Ok(None)),
            ("Ok", Some("  "), Ok(None)),
            ("", Some("/abs/path"), Err(())),
            ("   ", None, Err(())),
            ("Ok", Some("relative/path"), Err(())),
            ("Ok", Some("./here"), Err(())),
        ];
        let conn = open_in_memory().expect("db");
        for &(name, root, expected) in cases {
            let res = create(
                &conn,
                &CreateSubjectInput {
                    name: name.into(),
                    color: Some(SubjectColor::Pink),
                    root_path: root.map(String::from),
                    parent_id: None,
                },
            );
            match (res, expected) {
                (Ok(s), Ok(root_path)) => assert_eq!(s.root_path.as_deref(), root_path),
                (Err(e), Err(())) => assert!(matches!(e, AppError::Invalid(_))),
                (res, expected) => panic!("{name:?} {root:?}: {res:?} vs {expected:?}"),
            }
        }
    }

    #[test]
    fn update_fields_and_unlink_folder() {
        let conn = open_in_memory().expect("db");
        let a = create(&conn, &input("Alpha")).expect("create");
        let patch = |name: Option<&str>, color, root: Option<&str>| UpdateSubjectInput {
            id: a.id.clone(),
            name: name.map(String::from),
            color,
            root_path: root.map(String::from),
            parent_id: None,
        };
        let u = update(
            &conn,
            &patch(Some("Renamed"), Some(SubjectColor::Indigo), None),
        )
        .expect("update");
        assert_eq!(u.name, "Renamed");
        assert_eq!(u.color, SubjectColor::Indigo);
        assert_eq!(u.root_path, a.root_path);
        let bad = update(&conn, &patch(None, None, Some("rel")));
        assert!(matches!(bad, Err(AppError::Invalid(_))));
        let unlinked = update(&conn, &patch(None, None, Some(""))).expect("unlink");
        assert_eq!(unlinked.root_path, None);
        let linked = update(&conn, &patch(None, None, Some("/new"))).expect("link");
        assert_eq!(linked.root_path.as_deref(), Some("/new"));
        let missing = update(
            &conn,
            &UpdateSubjectInput {
                id: "nope".into(),
                name: None,
                color: None,
                root_path: None,
                parent_id: None,
            },
        );
        assert!(matches!(missing, Err(AppError::NotFound(_))));
    }

    #[test]
    fn reorder_and_delete() {
        let conn = open_in_memory().expect("db");
        let a = create(&conn, &input("A")).expect("create");
        let _b = create(&conn, &input("B")).expect("create");
        let c = create(&conn, &input("C")).expect("create");
        let names = |conn: &Connection| -> Vec<String> {
            list(conn)
                .expect("list")
                .into_iter()
                .map(|s| s.name)
                .collect()
        };
        reorder(
            &conn,
            &ReorderInput {
                id: c.id.clone(),
                index: 0,
            },
        )
        .expect("reorder");
        assert_eq!(names(&conn), vec!["C", "A", "B"]);
        reorder(
            &conn,
            &ReorderInput {
                id: c.id.clone(),
                index: 5,
            },
        )
        .expect("reorder");
        assert_eq!(names(&conn), vec!["A", "B", "C"]);
        delete(&conn, &a.id).expect("delete");
        assert_eq!(names(&conn), vec!["B", "C"]);
        assert!(matches!(get(&conn, &a.id), Err(AppError::NotFound(_))));
        assert!(matches!(delete(&conn, &a.id), Err(AppError::NotFound(_))));
        assert!(matches!(
            reorder(
                &conn,
                &ReorderInput {
                    id: a.id.clone(),
                    index: 0
                }
            ),
            Err(AppError::NotFound(_))
        ));
        // Indexes refer to live subjects only: C to index 0 among B, C.
        reorder(
            &conn,
            &ReorderInput {
                id: c.id.clone(),
                index: 0,
            },
        )
        .expect("reorder");
        assert_eq!(names(&conn), vec!["C", "B"]);
    }

    #[test]
    fn delete_hides_tasks_and_restore_brings_back_only_those() {
        let conn = open_in_memory().expect("db");
        let s = create(&conn, &input("S")).expect("create").id;
        let kept = task(&conn, "kept", Some(&s), None);
        let alone = task(&conn, "deleted alone", Some(&s), None);
        tasks::delete(&conn, &alone).expect("delete task");
        backdate_deletion(&conn, "tasks", &alone);
        delete(&conn, &s).expect("delete subject");
        assert!(matches!(
            tasks::load(&conn, &kept),
            Err(AppError::NotFound(_))
        ));
        assert!(list(&conn).expect("list").is_empty());
        let restored = restore(&conn, &s).expect("restore");
        assert_eq!(restored.open_count, 1);
        assert!(tasks::load(&conn, &kept).is_ok());
        assert!(matches!(
            tasks::load(&conn, &alone),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(restore(&conn, &s), Err(AppError::NotFound(_))));
        assert!(matches!(restore(&conn, "nope"), Err(AppError::NotFound(_))));
    }
}

/// Taido V2.2 bis: groups (they replace the old sub-projects).
#[cfg(test)]
mod group_tests;
