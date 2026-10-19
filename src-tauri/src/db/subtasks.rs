//! Subtasks: the child tasks of a task (`tasks.parent_id`, one level
//! only). The `*_subtask` commands act on them: adding creates a child in the parent's
//! place, toggling completes or reopens it, deleting is the tasks' soft delete.

use chrono::NaiveDate;
use rusqlite::{params, Connection};

use crate::db::positions::{self, Scope};
use crate::db::{now_utc, tasks};
use crate::error::{AppError, AppResult};
use crate::model::{
    AddSubtaskInput, ReorderInput, SetCompletedInput, Subtask, UpdateSubtaskInput, UpdateTaskInput,
};
use crate::views::rows::{self, Filter};

fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

/// Adds a child task at the end of the task's subtasks (`invalid` under a subtask).
pub fn add(conn: &Connection, input: &AddSubtaskInput) -> AppResult<Subtask> {
    let id = tasks::create_child(conn, &input.task_id, &input.text)?;
    get(conn, &id)
}

/// A live child task, as its parent's panel lists it.
pub fn get(conn: &Connection, id: &str) -> AppResult<Subtask> {
    let facts = rows::load(conn, Filter::Ids(&[id.to_string()]))?
        .into_iter()
        .next();
    match facts {
        Some(f) => match f.parent_id.as_deref() {
            Some(parent) => Ok(f.to_subtask(parent, today())),
            None => Err(AppError::NotFound(format!("subtask {id}"))),
        },
        None => Err(AppError::NotFound(format!("subtask {id}"))),
    }
}

/// Subtasks of a task: open ones by position, then completed ones, most recent first
/// (`TaskDetail.subtasks` in the app).
#[cfg(test)]
pub fn list_for_task(conn: &Connection, task_id: &str) -> AppResult<Vec<Subtask>> {
    let today = today();
    Ok(rows::load(conn, Filter::Ids(&[task_id.to_string()]))?
        .into_iter()
        .next()
        .map(|t| {
            t.children
                .iter()
                .map(|c| c.to_subtask(task_id, today))
                .collect()
        })
        .unwrap_or_default())
}

/// Renames the subtask (its title).
pub fn update(conn: &Connection, input: &UpdateSubtaskInput) -> AppResult<Subtask> {
    get(conn, &input.id)?;
    tasks::update(
        conn,
        &UpdateTaskInput {
            id: input.id.clone(),
            title: Some(input.text.clone()),
            description: None,
        },
    )?;
    get(conn, &input.id)
}

/// Completes an open subtask, reopens a completed one (journal `completed` / `reopened`).
pub fn toggle(conn: &Connection, id: &str) -> AppResult<Subtask> {
    let subtask = get(conn, id)?;
    tasks::set_completed(
        conn,
        &SetCompletedInput {
            id: id.to_string(),
            completed: !subtask.done,
        },
    )?;
    get(conn, id)
}

/// Soft delete, like a task (`restore_task` undoes it).
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    get(conn, id)?;
    tasks::delete(conn, id)
}

/// Moves the subtask to `index` among its parent's open subtasks.
pub fn reorder(conn: &Connection, input: &ReorderInput) -> AppResult<()> {
    let subtask = get(conn, &input.id)?;
    // Renumbering (if any) and the update share one transaction.
    let tx = conn.unchecked_transaction()?;
    let position = positions::at_index(
        &tx,
        Scope::Subtasks {
            task_id: &subtask.task_id,
        },
        Some(&input.id),
        input.index as usize,
    )?;
    tx.execute(
        "UPDATE tasks SET position = ?2, updated_at = ?3 WHERE id = ?1",
        params![input.id, position, now_utc()],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;
    use crate::db::test_support::task;
    use crate::model::Ring;

    fn texts(conn: &Connection, task_id: &str) -> Vec<String> {
        list_for_task(conn, task_id)
            .expect("list")
            .into_iter()
            .map(|s| s.text)
            .collect()
    }

    fn add_one(conn: &Connection, task_id: &str, text: &str) -> AppResult<Subtask> {
        add(
            conn,
            &AddSubtaskInput {
                task_id: task_id.into(),
                text: text.into(),
            },
        )
    }

    #[test]
    fn crud_and_reorder() {
        let conn = open_in_memory().expect("db");
        let t = task(&conn, "T", None, None);
        let other = task(&conn, "O", None, None);
        let a = add_one(&conn, &t, " a ").expect("add");
        let b = add_one(&conn, &t, "b").expect("add");
        let c = add_one(&conn, &t, "c").expect("add");
        let x = add_one(&conn, &other, "x").expect("add");
        assert_eq!(
            (a.position, b.position, c.position, x.position),
            (1.0, 2.0, 3.0, 1.0)
        );
        assert_eq!(a.text, "a");
        assert_eq!(a.task_id, t);
        assert!(!a.done);
        assert_eq!(
            (a.ring, a.priority, a.due.clone(), a.open_terminals),
            (Ring::Human, 1, None, 0)
        );
        assert!(matches!(
            add_one(&conn, &t, "  "),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            add_one(&conn, "nope", "z"),
            Err(AppError::NotFound(_))
        ));

        assert!(toggle(&conn, &a.id).expect("toggle").done);
        assert!(!toggle(&conn, &a.id).expect("toggle").done);
        let u = update(
            &conn,
            &UpdateSubtaskInput {
                id: b.id.clone(),
                text: "B!".into(),
            },
        )
        .expect("update");
        assert_eq!(u.text, "B!");
        assert!(update(
            &conn,
            &UpdateSubtaskInput {
                id: b.id.clone(),
                text: "".into(),
            },
        )
        .is_err());

        reorder(
            &conn,
            &ReorderInput {
                id: c.id.clone(),
                index: 0,
            },
        )
        .expect("reorder");
        assert_eq!(texts(&conn, &t), vec!["c", "a", "B!"]);
        reorder(
            &conn,
            &ReorderInput {
                id: c.id.clone(),
                index: 1,
            },
        )
        .expect("reorder");
        assert_eq!(texts(&conn, &t), vec!["a", "c", "B!"]);

        delete(&conn, &a.id).expect("delete");
        assert_eq!(texts(&conn, &t), vec!["c", "B!"]);
        assert!(matches!(delete(&conn, &a.id), Err(AppError::NotFound(_))));
        assert!(matches!(toggle(&conn, &a.id), Err(AppError::NotFound(_))));
        assert_eq!(texts(&conn, &other), vec!["x"]);
        // Deleting a subtask is undone like a task's deletion.
        tasks::restore(&conn, &a.id).expect("restore");
        assert_eq!(texts(&conn, &t), vec!["a", "c", "B!"]);
    }

    #[test]
    fn a_subtask_is_a_child_task_in_its_parents_place() {
        let conn = open_in_memory().expect("db");
        let s = crate::db::test_support::subject(&conn, "S");
        let sec = crate::db::test_support::section(&conn, &s, "Sec");
        let parent = task(&conn, "Parent", Some(&s), Some(&sec));
        let child = add_one(&conn, &parent, "child").expect("add");
        let record = tasks::load(&conn, &child.id).expect("load");
        assert_eq!(record.parent_id.as_deref(), Some(parent.as_str()));
        assert_eq!(record.subject_id.as_deref(), Some(s.as_str()));
        assert_eq!(record.section_id.as_deref(), Some(sec.as_str()));
        // One level only.
        assert!(matches!(
            add_one(&conn, &child.id, "grandchild"),
            Err(AppError::Invalid(_))
        ));
        // A top-level task is not a subtask.
        assert!(matches!(get(&conn, &parent), Err(AppError::NotFound(_))));
        // Its journal starts with "created".
        let journal = crate::db::journal::list(&conn, &child.id).expect("journal");
        assert_eq!(journal.len(), 1);
    }

    #[test]
    fn completed_subtasks_come_last_most_recent_first() {
        let conn = open_in_memory().expect("db");
        let t = task(&conn, "T", None, None);
        let ids: Vec<String> = ["a", "b", "c", "d"]
            .iter()
            .map(|text| add_one(&conn, &t, text).expect("add").id)
            .collect();
        let complete_at = |id: &str, at: &str| {
            conn.execute(
                "UPDATE tasks SET completed_at = ?2 WHERE id = ?1",
                params![id, at],
            )
            .expect("complete");
        };
        complete_at(&ids[0], "2026-10-01T10:00:00.000Z");
        complete_at(&ids[2], "2026-10-02T10:00:00.000Z");
        assert_eq!(texts(&conn, &t), vec!["b", "d", "c", "a"]);
        // An index counts open subtasks only.
        reorder(
            &conn,
            &ReorderInput {
                id: ids[3].clone(),
                index: 0,
            },
        )
        .expect("reorder");
        assert_eq!(texts(&conn, &t), vec!["d", "b", "c", "a"]);
    }
}
