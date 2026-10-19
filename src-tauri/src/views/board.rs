//! Kanban of a project (Taido V2.2). Product decision (2026-10-09): the columns are
//! the progress of the tasks, set by hand (`db::board_columns`), not Claude's states; Claude's
//! state shows on each card (its dot and its chrono).

use chrono::NaiveDate;
use rusqlite::Connection;

use crate::db::{board_columns, subjects};
use crate::error::AppResult;
use crate::model::{Board, BoardColumn};
use crate::views::rows::{self, Filter};

/// Cards « Terminé » shows; the rest is counted (« + N autres »).
pub const DONE_SHOWN: usize = 3;

/// Kanban of a project, or of « Sans projet » when `subject_id` is `None`.
pub fn board(conn: &Connection, subject_id: Option<&str>, today: NaiveDate) -> AppResult<Board> {
    let subject = subject_id.map(|id| subjects::get(conn, id)).transpose()?;
    let filter = |completed| match subject_id {
        Some(id) => Filter::Subject { id, completed },
        None => Filter::Inbox { completed },
    };
    let mut open = rows::load(conn, filter(false))?;
    // The list's order: tasks without section first, then each section in turn.
    let sections = subject
        .as_ref()
        .map(|s| s.sections.as_slice())
        .unwrap_or(&[]);
    let rank = |section: Option<&str>| -> usize {
        section
            .and_then(|id| sections.iter().position(|s| s.id == id))
            .map_or(0, |i| i + 1)
    };
    open.sort_by(|a, b| {
        rank(a.section_id.as_deref())
            .cmp(&rank(b.section_id.as_deref()))
            .then(a.position.total_cmp(&b.position))
    });
    let completed = rows::load(conn, filter(true))?;
    let rows_of = board_columns::ensure(conn, subject_id)?;
    let mut columns: Vec<BoardColumn> = rows_of
        .iter()
        .map(|c| BoardColumn {
            id: c.id.clone(),
            name: c.name.clone(),
            is_done: c.is_done,
            cards: Vec::new(),
            total: 0,
        })
        .collect();
    for task in open.iter().chain(completed.iter()) {
        let index = board_columns::index_of(
            &rows_of,
            task.board_column_id.as_deref(),
            task.completed_at.is_some(),
        );
        let column = &mut columns[index];
        column.total += 1;
        if !column.is_done || column.cards.len() < DONE_SHOWN {
            column.cards.push(task.to_row(today, false));
        }
    }
    Ok(Board {
        subject_id: subject.map(|s| s.id),
        columns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, tasks, test_support};
    use crate::model::SetCompletedInput;

    fn titles(board: &Board, index: usize) -> Vec<String> {
        board.columns[index]
            .cards
            .iter()
            .map(|c| c.title.clone())
            .collect()
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 9).expect("date")
    }

    #[test]
    fn cards_sit_in_their_progress_column() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "Summit Events");
        test_support::task(&conn, "Appel de recette", Some(&p), None);
        let export = test_support::task(&conn, "Export PDF", Some(&p), None);
        let b = board(&conn, Some(&p), today()).expect("board");
        assert_eq!(
            b.columns
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            board_columns::DEFAULT_COLUMNS
        );
        assert_eq!(titles(&b, 0), ["Appel de recette", "Export PDF"]);
        // Claude on « Export PDF »: « En cours », and the card keeps its column while
        // Claude waits (the state shows on the card).
        test_support::claude_terminal(&conn, &export, "t1", "s1", "c1");
        test_support::set_session_state(
            &conn,
            "s1",
            "waiting",
            Some("question"),
            "2026-10-09T10:00:00.000Z",
        );
        let b = board(&conn, Some(&p), today()).expect("board");
        assert_eq!(titles(&b, 1), ["Export PDF"]);
        assert_eq!(b.columns[1].cards[0].ring, crate::model::Ring::Waiting);
    }

    #[test]
    fn done_shows_the_last_three() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "Summit Events");
        for i in 0..5 {
            let id = test_support::task(&conn, &format!("T{i}"), Some(&p), None);
            tasks::set_completed(
                &conn,
                &SetCompletedInput {
                    id,
                    completed: true,
                },
            )
            .expect("complete");
        }
        let b = board(&conn, Some(&p), today()).expect("board");
        let done = b.columns.last().expect("done");
        assert!(done.is_done);
        assert_eq!(done.cards.len(), 3);
        assert_eq!(done.total, 5);
    }

    #[test]
    fn the_inbox_has_its_kanban() {
        let conn = open_in_memory().expect("db");
        let p = test_support::subject(&conn, "Summit Events");
        test_support::task(&conn, "Dans un projet", Some(&p), None);
        test_support::task(&conn, "Sans projet", None, None);
        let b = board(&conn, None, today()).expect("board");
        assert_eq!(b.subject_id, None);
        assert_eq!(titles(&b, 0), ["Sans projet"]);
    }
}
