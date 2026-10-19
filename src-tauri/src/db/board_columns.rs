//! Kanban columns (Taido V2.2, 2026-10-09): the progress of the tasks, per project.
//!
//! Each project, and « Sans projet » (`subject_id` NULL), has its own ordered columns, created
//! on first use with [`i18n::default_columns`] (the language of the moment). The last one is the done column: it holds the
//! completed tasks, and moving a card there completes its task. A task without column, or
//! whose column belongs to another project (it moved), is in the first column. Launching
//! Claude on a task of the first column moves it once to the second ([`advance_on_claude`]).

use rusqlite::{params, Connection, OptionalExtension};
use sync_proto::EPOCH_STAMP;

use crate::db::{new_id, non_empty, now_utc, tasks};
use crate::error::{AppError, AppResult};
use crate::i18n;
use crate::model::SetCompletedInput;

/// One column, in board order.
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnRow {
    pub id: String,
    pub name: String,
    pub is_done: bool,
}

/// The board's columns in order (the done column last), without creating them.
fn list(conn: &Connection, subject_id: Option<&str>) -> AppResult<Vec<ColumnRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, is_done FROM board_columns WHERE subject_id IS ?1 \
         ORDER BY is_done, position, id",
    )?;
    let rows = stmt.query_map([subject_id], |r| {
        Ok(ColumnRow {
            id: r.get(0)?,
            name: r.get(1)?,
            is_done: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Id of a default column: fixed, `col-<project>-<index>` (`col-inbox-<index>` for « Sans
/// projet »), so that two devices creating the same board before syncing make the same rows
///. Columns added later get random ids.
pub fn default_id(subject_id: Option<&str>, index: usize) -> String {
    format!("col-{}-{index}", subject_id.unwrap_or("inbox"))
}

/// A default column goes out with its known version, else [`EPOCH_STAMP`], instead of the
/// stamp of its creation (as a re-enqueue, docs/SYNC.md § 2.6): created late on a device that
/// never pulled the board, it must lose to any real edit made elsewhere (a rename, a move).
fn queue_as_default(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE sync_outbox SET changed_at = COALESCE((SELECT stamp FROM sync_known \
         WHERE entity = 'board_column' AND id = ?1), ?2) \
         WHERE entity = 'board_column' AND id = ?1 AND purged = 0",
        params![id, EPOCH_STAMP],
    )?;
    Ok(())
}

/// The board's columns, created with the defaults the first time (an id already there, made
/// by another device and pulled, is kept as it is).
pub fn ensure(conn: &Connection, subject_id: Option<&str>) -> AppResult<Vec<ColumnRow>> {
    let columns = list(conn, subject_id)?;
    if !columns.is_empty() {
        return Ok(columns);
    }
    let now = now_utc();
    let names = i18n::default_columns(i18n::current_language(conn));
    // A savepoint: `ensure` also runs inside other transactions (a Claude launch).
    conn.execute_batch("SAVEPOINT ensure_columns")?;
    let created = (|| -> AppResult<()> {
        for (i, name) in names.iter().enumerate() {
            let id = default_id(subject_id, i);
            let inserted = conn.execute(
                "INSERT INTO board_columns (id, subject_id, name, position, is_done, \
                 created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
                 ON CONFLICT(id) DO NOTHING",
                params![id, subject_id, name, i as f64, i == names.len() - 1, now],
            )?;
            if inserted > 0 {
                queue_as_default(conn, &id)?;
            }
        }
        Ok(())
    })();
    match created {
        Ok(()) => conn.execute_batch("RELEASE ensure_columns")?,
        Err(e) => {
            conn.execute_batch("ROLLBACK TO ensure_columns; RELEASE ensure_columns")?;
            return Err(e);
        }
    }
    list(conn, subject_id)
}

/// Index of the column a task sits in: the done column when completed, its own column when it
/// belongs to this board, else the first.
pub fn index_of(columns: &[ColumnRow], column_id: Option<&str>, completed: bool) -> usize {
    if completed {
        if let Some(i) = columns.iter().position(|c| c.is_done) {
            return i;
        }
    }
    column_id
        .and_then(|id| columns.iter().position(|c| c.id == id && !c.is_done))
        .unwrap_or(0)
}

/// The board (subject) a column belongs to, and whether it is the done column.
fn column(conn: &Connection, id: &str) -> AppResult<(Option<String>, bool)> {
    conn.query_row(
        "SELECT subject_id, is_done FROM board_columns WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("board column {id}")))
}

/// « + Ajouter une colonne »: a new column just before the done column.
pub fn create(conn: &Connection, subject_id: Option<&str>, name: &str) -> AppResult<String> {
    let name = non_empty(name, "column name")?;
    ensure(conn, subject_id)?;
    let position: f64 = conn.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM board_columns \
         WHERE subject_id IS ?1 AND is_done = 0",
        [subject_id],
        |r| r.get(0),
    )?;
    let id = new_id();
    let now = now_utc();
    conn.execute(
        "INSERT INTO board_columns (id, subject_id, name, position, is_done, created_at, \
         updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        params![id, subject_id, name, position, now],
    )?;
    Ok(id)
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> AppResult<()> {
    let name = non_empty(name, "column name")?;
    let n = conn.execute(
        "UPDATE board_columns SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, name, now_utc()],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("board column {id}")));
    }
    Ok(())
}

/// Removes a column; its tasks go back to the first column. The done column and the last
/// column of work stay.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let (subject_id, is_done) = column(conn, id)?;
    if is_done {
        return Err(AppError::Invalid(
            "the done column cannot be removed".into(),
        ));
    }
    let work = list(conn, subject_id.as_deref())?
        .iter()
        .filter(|c| !c.is_done)
        .count();
    if work <= 1 {
        return Err(AppError::Invalid("a board keeps one column of work".into()));
    }
    conn.execute("DELETE FROM board_columns WHERE id = ?1", [id])?;
    Ok(())
}

/// Moves a column of work to `index` among the columns of work (the done column stays last).
pub fn move_column(conn: &Connection, id: &str, index: usize) -> AppResult<()> {
    let (subject_id, is_done) = column(conn, id)?;
    if is_done {
        return Err(AppError::Invalid("the done column stays last".into()));
    }
    let mut work: Vec<String> = list(conn, subject_id.as_deref())?
        .into_iter()
        .filter(|c| !c.is_done)
        .map(|c| c.id)
        .collect();
    work.retain(|c| c != id);
    work.insert(index.min(work.len()), id.to_string());
    let tx = conn.unchecked_transaction()?;
    let now = now_utc();
    for (i, c) in work.iter().enumerate() {
        tx.execute(
            "UPDATE board_columns SET position = ?2, updated_at = ?3 WHERE id = ?1",
            params![c, i as f64, now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Moves a card. To the done column: completes the task. Out of it: reopens it.
pub fn move_task(conn: &Connection, task_id: &str, column_id: &str) -> AppResult<()> {
    let task = tasks::load(conn, task_id)?;
    let (subject_id, is_done) = column(conn, column_id)?;
    if subject_id != task.subject_id {
        return Err(AppError::Invalid(
            "a card moves within its own project's board".into(),
        ));
    }
    if is_done {
        tasks::set_completed(
            conn,
            &SetCompletedInput {
                id: task_id.to_string(),
                completed: true,
            },
        )?;
        return Ok(());
    }
    conn.execute(
        "UPDATE tasks SET board_column_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![task_id, column_id, now_utc()],
    )?;
    if task.completed_at.is_some() {
        tasks::set_completed(
            conn,
            &SetCompletedInput {
                id: task_id.to_string(),
                completed: false,
            },
        )?;
    }
    Ok(())
}

/// A Claude session starts on a task: from the first column it goes, once, to the second
/// (« À faire » → « En cours »). Elsewhere, nothing moves.
pub fn advance_on_claude(conn: &Connection, task_id: &str) -> AppResult<bool> {
    let task: Option<(Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT subject_id, board_column_id, completed_at FROM tasks WHERE id = ?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((subject_id, column_id, completed_at)) = task else {
        return Ok(false);
    };
    if completed_at.is_some() {
        return Ok(false);
    }
    let columns = ensure(conn, subject_id.as_deref())?;
    if index_of(&columns, column_id.as_deref(), false) != 0 {
        return Ok(false);
    }
    let Some(next) = columns.get(1).filter(|c| !c.is_done) else {
        return Ok(false);
    };
    conn.execute(
        "UPDATE tasks SET board_column_id = ?2 WHERE id = ?1",
        params![task_id, next.id],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, test_support};
    use crate::model::Language;

    fn names(columns: &[ColumnRow]) -> Vec<String> {
        columns.iter().map(|c| c.name.clone()).collect()
    }

    fn column_of(conn: &Connection, task: &str) -> Option<String> {
        conn.query_row(
            "SELECT board_column_id FROM tasks WHERE id = ?1",
            [task],
            |r| r.get(0),
        )
        .expect("column")
    }

    fn set_language(conn: &Connection, language: Option<crate::model::Language>) {
        match language {
            Some(l) => {
                crate::db::settings::update(
                    conn,
                    &crate::model::SettingsPatch {
                        language: Some(l),
                        ..Default::default()
                    },
                )
                .expect("language");
            }
            None => {
                conn.execute("DELETE FROM settings WHERE key = 'language'", [])
                    .expect("clear");
            }
        }
    }

    #[test]
    fn default_board_columns_in_english_when_language_is_en() {
        let conn = open_in_memory().expect("db");
        set_language(&conn, Some(crate::model::Language::En));
        let p = test_support::subject(&conn, "Summit Events");
        let columns = ensure(&conn, Some(&p)).expect("ensure");
        assert_eq!(
            names(&columns),
            ["To do", "In progress", "To review", "Done"]
        );
        assert!(columns[3].is_done);
    }

    #[test]
    fn default_board_columns_are_english_while_the_language_is_unset() {
        let conn = open_in_memory().expect("db");
        set_language(&conn, None);
        let columns = ensure(&conn, None).expect("ensure");
        assert_eq!(
            names(&columns),
            ["To do", "In progress", "To review", "Done"]
        );
    }

    #[test]
    fn default_board_columns_in_french_when_language_is_fr() {
        let conn = open_in_memory().expect("db");
        set_language(&conn, Some(crate::model::Language::Fr));
        let columns = ensure(&conn, None).expect("ensure");
        assert_eq!(
            names(&columns),
            ["À faire", "En cours", "À valider", "Terminé"]
        );
    }

    #[test]
    fn a_board_starts_with_the_default_columns() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "Summit Events");
        let columns = ensure(&conn, Some(&p)).expect("ensure");
        assert_eq!(names(&columns), i18n::default_columns(Language::Fr));
        assert!(columns[3].is_done);
        assert_eq!(ensure(&conn, Some(&p)).expect("again"), columns);
        // « Sans projet » has its own.
        assert_eq!(ensure(&conn, None).expect("inbox").len(), 4);
        assert_ne!(ensure(&conn, None).expect("inbox")[0].id, columns[0].id);
    }

    #[test]
    fn columns_are_added_renamed_moved_and_removed() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "P");
        let id = create(&conn, Some(&p), "Chez le client").expect("create");
        let columns = ensure(&conn, Some(&p)).expect("list");
        assert_eq!(
            names(&columns),
            [
                "À faire",
                "En cours",
                "À valider",
                "Chez le client",
                "Terminé"
            ]
        );
        rename(&conn, &id, "Envoyé").expect("rename");
        move_column(&conn, &id, 1).expect("move");
        let columns = ensure(&conn, Some(&p)).expect("list");
        assert_eq!(
            names(&columns),
            ["À faire", "Envoyé", "En cours", "À valider", "Terminé"]
        );
        let task = test_support::task(&conn, "T", Some(&p), None);
        move_task(&conn, &task, &id).expect("move task");
        delete(&conn, &id).expect("delete");
        assert_eq!(column_of(&conn, &task), None, "back to the first column");
        let done = ensure(&conn, Some(&p)).expect("list")[3].id.clone();
        assert!(delete(&conn, &done).is_err());
        assert!(move_column(&conn, &done, 0).is_err());
    }

    #[test]
    fn the_last_column_of_work_stays() {
        let conn = open_in_memory().expect("db");
        let columns = ensure(&conn, None).expect("inbox");
        delete(&conn, &columns[0].id).expect("first");
        delete(&conn, &columns[1].id).expect("second");
        assert!(delete(&conn, &columns[2].id).is_err());
    }

    #[test]
    fn the_done_column_completes_and_leaving_it_reopens() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "P");
        let task = test_support::task(&conn, "T", Some(&p), None);
        let columns = ensure(&conn, Some(&p)).expect("columns");
        move_task(&conn, &task, &columns[3].id).expect("done");
        assert!(tasks::load(&conn, &task).expect("t").completed_at.is_some());
        move_task(&conn, &task, &columns[1].id).expect("back");
        assert!(tasks::load(&conn, &task).expect("t").completed_at.is_none());
        assert_eq!(column_of(&conn, &task), Some(columns[1].id.clone()));
        // Another project's column is refused.
        let other = ensure(&conn, None).expect("inbox");
        assert!(move_task(&conn, &task, &other[1].id).is_err());
    }

    #[test]
    fn launching_claude_moves_a_todo_task_once() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "P");
        let task = test_support::task(&conn, "T", Some(&p), None);
        let columns = ensure(&conn, Some(&p)).expect("columns");
        test_support::claude_terminal(&conn, &task, "t1", "s1", "c1");
        assert_eq!(column_of(&conn, &task), Some(columns[1].id.clone()));
        // Moved by hand to « À valider »: another session leaves it there.
        move_task(&conn, &task, &columns[2].id).expect("move");
        test_support::claude_terminal(&conn, &task, "t2", "s2", "c2");
        assert_eq!(column_of(&conn, &task), Some(columns[2].id.clone()));
    }

    #[test]
    fn index_rules() {
        let columns: Vec<ColumnRow> = i18n::default_columns(Language::Fr)
            .iter()
            .enumerate()
            .map(|(i, n)| ColumnRow {
                id: format!("c{i}"),
                name: (*n).into(),
                is_done: i == 3,
            })
            .collect();
        assert_eq!(index_of(&columns, None, false), 0);
        assert_eq!(index_of(&columns, Some("c2"), false), 2);
        assert_eq!(index_of(&columns, Some("elsewhere"), false), 0);
        assert_eq!(index_of(&columns, Some("c1"), true), 3);
        assert_eq!(
            index_of(&columns, Some("c3"), false),
            0,
            "done needs completion"
        );
    }
}
