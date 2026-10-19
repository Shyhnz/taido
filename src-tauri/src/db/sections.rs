//! Sections repository.

use std::path::{Component, Path};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::positions::{self, Scope};
use crate::db::{new_id, non_empty, now_utc, subjects};
use crate::error::{AppError, AppResult};
use crate::model::{CreateSectionInput, ReorderInput, Section, UpdateSectionInput};

const COLUMNS: &str = concat!(
    "id, subject_id, name, subpath, position, \
     (SELECT COUNT(*) FROM tasks t WHERE t.section_id = sections.id \
     AND t.completed_at IS NULL AND t.deleted_at IS NULL AND ",
    crate::db::listed_open_sql!(),
    ")"
);

pub fn create(conn: &Connection, input: &CreateSectionInput) -> AppResult<Section> {
    subjects::ensure_project(conn, &input.subject_id)?;
    let name = non_empty(&input.name, "section name")?;
    let subpath = match &input.subpath {
        Some(p) => validate_subpath(p)?,
        None => None,
    };
    let id = new_id();
    let now = now_utc();
    let position = positions::append(
        conn,
        Scope::Sections {
            subject_id: &input.subject_id,
        },
    )?;
    conn.execute(
        "INSERT INTO sections (id, subject_id, name, subpath, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, input.subject_id, name, subpath, position, now],
    )?;
    get(conn, &id)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Section> {
    let sql = format!("SELECT {COLUMNS} FROM sections WHERE id = ?1");
    conn.query_row(&sql, [id], from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("section {id}")))
}

/// Sections of a subject in display order.
pub fn list_for_subject(conn: &Connection, subject_id: &str) -> AppResult<Vec<Section>> {
    let sql = format!("SELECT {COLUMNS} FROM sections WHERE subject_id = ?1 ORDER BY position, id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([subject_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn update(conn: &Connection, input: &UpdateSectionInput) -> AppResult<Section> {
    let current = get(conn, &input.id)?;
    let name = match &input.name {
        Some(n) => non_empty(n, "section name")?,
        None => current.name,
    };
    let subpath = match &input.subpath {
        Some(p) => validate_subpath(p)?,
        None => current.subpath,
    };
    conn.execute(
        "UPDATE sections SET name = ?2, subpath = ?3, updated_at = ?4 WHERE id = ?1",
        params![input.id, name, subpath, now_utc()],
    )?;
    get(conn, &input.id)
}

/// Deletes the section; its tasks go back outside sections, after the existing ones
/// (FK `ON DELETE SET NULL`).
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let subject_id: String = tx
        .query_row("SELECT subject_id FROM sections WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("section {id}")))?;
    // Keep the moved tasks after the existing "Sans section" ones, in their order.
    let base = positions::append(
        &tx,
        Scope::Tasks {
            subject_id: Some(&subject_id),
            section_id: None,
        },
    )?;
    let min: Option<f64> = tx.query_row(
        "SELECT MIN(position) FROM tasks WHERE section_id = ?1 AND parent_id IS NULL",
        [id],
        |r| r.get(0),
    )?;
    if let Some(min) = min {
        // Children keep their order under their parent; they follow it by `ON DELETE SET NULL`.
        tx.execute(
            "UPDATE tasks SET position = ?2 + position - ?3 \
             WHERE section_id = ?1 AND parent_id IS NULL",
            params![id, base, min],
        )?;
    }
    tx.execute("DELETE FROM sections WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

/// Renumbering (if any) and the update share one transaction.
pub fn reorder(conn: &Connection, input: &ReorderInput) -> AppResult<()> {
    let section = get(conn, &input.id)?;
    let tx = conn.unchecked_transaction()?;
    let position = positions::at_index(
        &tx,
        Scope::Sections {
            subject_id: &section.subject_id,
        },
        Some(&input.id),
        input.index as usize,
    )?;
    tx.execute(
        "UPDATE sections SET position = ?2, updated_at = ?3 WHERE id = ?1",
        params![input.id, position, now_utc()],
    )?;
    tx.commit()?;
    Ok(())
}

/// Relative subfolder without `..`; an empty string clears it (`None`).
pub fn validate_subpath(path: &str) -> AppResult<Option<String>> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let p = Path::new(trimmed);
    let valid = p
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !valid {
        return Err(AppError::Invalid(format!(
            "section subfolder must be relative, without '..': {trimmed}"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<Section> {
    Ok(Section {
        id: r.get(0)?,
        subject_id: r.get(1)?,
        name: r.get(2)?,
        subpath: r.get(3)?,
        position: r.get(4)?,
        open_count: r.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{section, subject, task};
    use crate::db::{open_in_memory, tasks};

    #[test]
    fn subpath_validation() {
        let cases: &[(&str, Result<Option<&str>, ()>)] = &[
            ("", Ok(None)),
            ("   ", Ok(None)),
            ("front", Ok(Some("front"))),
            (" apps/web ", Ok(Some("apps/web"))),
            ("./apps", Ok(Some("./apps"))),
            ("/abs", Err(())),
            ("..", Err(())),
            ("apps/../..", Err(())),
            ("../sibling", Err(())),
        ];
        for (input, expected) in cases {
            let got = validate_subpath(input).map_err(|_| ());
            let expected = expected.map(|o| o.map(String::from));
            assert_eq!(got, expected, "input {input:?}");
        }
    }

    #[test]
    fn create_update_list() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let a = create(
            &conn,
            &CreateSectionInput {
                subject_id: s.clone(),
                name: " Front ".into(),
                subpath: Some("web".into()),
            },
        )
        .expect("create");
        assert_eq!(a.name, "Front");
        assert_eq!(a.subpath.as_deref(), Some("web"));
        assert_eq!(a.position, 1.0);
        let b = section(&conn, &s, "Back");
        assert_eq!(get(&conn, &b).expect("get").position, 2.0);
        let u = update(
            &conn,
            &UpdateSectionInput {
                id: a.id.clone(),
                name: None,
                subpath: Some(String::new()),
            },
        )
        .expect("update");
        assert_eq!(u.subpath, None);
        assert_eq!(u.name, "Front");
        let bad = create(
            &conn,
            &CreateSectionInput {
                subject_id: "missing".into(),
                name: "X".into(),
                subpath: None,
            },
        );
        assert!(matches!(bad, Err(AppError::NotFound(_))));
        let bad = create(
            &conn,
            &CreateSectionInput {
                subject_id: s.clone(),
                name: " ".into(),
                subpath: None,
            },
        );
        assert!(matches!(bad, Err(AppError::Invalid(_))));
        let sections = list_for_subject(&conn, &s).expect("list");
        assert_eq!(sections.len(), 2);
        let subj = subjects::get(&conn, &s).expect("subject");
        assert_eq!(subj.sections, sections);
    }

    #[test]
    fn reorder_within_subject() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let other = subject(&conn, "Other");
        let a = section(&conn, &s, "A");
        let _b = section(&conn, &s, "B");
        let _x = section(&conn, &other, "X");
        reorder(&conn, &ReorderInput { id: a, index: 1 }).expect("reorder");
        let names: Vec<_> = list_for_subject(&conn, &s)
            .expect("list")
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["B", "A"]);
    }

    #[test]
    fn delete_sends_tasks_to_no_section() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let sec = section(&conn, &s, "Sec");
        let loose = task(&conn, "loose", Some(&s), None);
        let t1 = task(&conn, "t1", Some(&s), Some(&sec));
        let t2 = task(&conn, "t2", Some(&s), Some(&sec));
        assert_eq!(get(&conn, &sec).expect("get").open_count, 2);
        delete(&conn, &sec).expect("delete");
        assert!(matches!(get(&conn, &sec), Err(AppError::NotFound(_))));
        let mut stmt = conn
            .prepare("SELECT id, section_id FROM tasks WHERE subject_id = ?1 ORDER BY position")
            .expect("prepare");
        let rows: Vec<(String, Option<String>)> = stmt
            .query_map([&s], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert_eq!(rows, vec![(loose, None), (t1.clone(), None), (t2, None)]);
        assert!(tasks::detail(&conn, &t1).expect("detail").section.is_none());
        assert!(matches!(delete(&conn, &sec), Err(AppError::NotFound(_))));
    }

    #[test]
    fn purging_a_deleted_subject_cascades_to_sections() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let sec = section(&conn, &s, "Sec");
        subjects::delete(&conn, &s).expect("delete");
        let later = chrono::Utc::now() + chrono::Duration::days(2);
        crate::db::trash::purge(&conn, later).expect("purge");
        assert!(matches!(get(&conn, &sec), Err(AppError::NotFound(_))));
    }

    #[test]
    fn open_count_ignores_deleted_tasks() {
        let conn = open_in_memory().expect("db");
        let s = subject(&conn, "S");
        let sec = section(&conn, &s, "Sec");
        let _a = task(&conn, "a", Some(&s), Some(&sec));
        let b = task(&conn, "b", Some(&s), Some(&sec));
        tasks::delete(&conn, &b).expect("delete");
        assert_eq!(get(&conn, &sec).expect("get").open_count, 1);
    }
}
