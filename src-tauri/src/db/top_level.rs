//! The top level of the sidebar and of « À faire »: the top-level projects and « Sans
//! projet » (the inbox) in one order.
//!
//! « Sans projet » lives in the position space of the top-level subjects
//! (`subjects.position` where `parent_id IS NULL`); its position is the synced setting
//! `inbox_position` (`db::synced_settings`). Rules:
//! - an inbox position equal to a subject's sorts the inbox after that subject;
//! - an inbox never placed sorts last, and is written only when it is moved, or when a
//!   project is dropped past it;
//! - once placed, it is a project like the others: new projects go after everything.

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::positions::MIN_GAP;
use crate::db::{now_utc, synced_settings};
use crate::error::{AppError, AppResult};

/// An item of the top level: a top-level project or « Sans projet ».
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopItem {
    Subject(String),
    Inbox,
}

/// An item of the order with its position (`None` for an inbox never placed).
struct Placed {
    item: TopItem,
    position: Option<f64>,
}

/// Live top-level subjects by (position, id), with the inbox inserted after every subject
/// whose position is ≤ its position, or last when it was never placed.
fn placed(conn: &Connection) -> AppResult<Vec<Placed>> {
    let mut stmt = conn.prepare(
        "SELECT id, position FROM subjects WHERE parent_id IS NULL AND deleted_at IS NULL \
         ORDER BY position, id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
    let mut items: Vec<Placed> = rows
        .map(|r| {
            r.map(|(id, position)| Placed {
                item: TopItem::Subject(id),
                position: Some(position),
            })
        })
        .collect::<Result<_, _>>()?;
    let inbox = synced_settings::inbox_position(conn)?;
    let at = match inbox {
        None => items.len(),
        Some(p) => items
            .iter()
            .take_while(|i| i.position.is_some_and(|x| x <= p))
            .count(),
    };
    items.insert(
        at,
        Placed {
            item: TopItem::Inbox,
            position: inbox,
        },
    );
    Ok(items)
}

/// The top-level order: live top-level projects and « Sans projet » (see the module rules).
pub fn order(conn: &Connection) -> AppResult<Vec<TopItem>> {
    Ok(placed(conn)?.into_iter().map(|p| p.item).collect())
}

/// Index of « Sans projet » in [`order`] (= live top-level projects ordered before it).
pub fn inbox_index(conn: &Connection) -> AppResult<u32> {
    let index = order(conn)?
        .iter()
        .position(|i| *i == TopItem::Inbox)
        .unwrap_or(0);
    Ok(u32::try_from(index).unwrap_or(u32::MAX))
}

/// Position after everything at the top level: max of every top-level subject (soft-deleted
/// included, they keep their place for a restore) and of the inbox when placed, plus 1; 1
/// when empty.
pub fn append_position(conn: &Connection) -> AppResult<f64> {
    let max: Option<f64> = conn.query_row(
        "SELECT MAX(position) FROM subjects WHERE parent_id IS NULL",
        [],
        |r| r.get(0),
    )?;
    let max = match (max, synced_settings::inbox_position(conn)?) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    Ok(max.map_or(1.0, |m| m + 1.0))
}

/// Moves `moving` to `index` of [`order`], the moved item excluded from the siblings (like
/// `positions::at_index`; past the end = last). A subject must be a live top-level project.
/// One transaction.
pub fn reorder(conn: &Connection, moving: &TopItem, index: usize) -> AppResult<()> {
    if let TopItem::Subject(id) = moving {
        ensure_live_top_level(conn, id)?;
    }
    let tx = conn.unchecked_transaction()?;
    let items: Vec<Placed> = placed(&tx)?
        .into_iter()
        .filter(|p| p.item != *moving)
        .collect();
    let inbox_unset = synced_settings::inbox_position(&tx)?.is_none();
    if inbox_unset && *moving != TopItem::Inbox && index >= items.len() {
        // Dropped past the inbox never placed (the last item): the inbox gets its place
        // first, so that the project lands after it.
        let inbox = append_position(&tx)?;
        synced_settings::set_inbox_position(&tx, inbox)?;
    }
    let position = slot(&tx, moving, index)?;
    write(&tx, moving, position)?;
    tx.commit()?;
    Ok(())
}

/// Position that puts `moving` at `index` among the other placed items (an inbox never
/// placed is left out: it stays last). Renumbers the level once when the gap is too small.
fn slot(conn: &Connection, moving: &TopItem, index: usize) -> AppResult<f64> {
    for _ in 0..2 {
        let real: Vec<f64> = placed(conn)?
            .into_iter()
            .filter(|p| p.item != *moving)
            .filter_map(|p| p.position)
            .collect();
        if index >= real.len() {
            return append_position(conn);
        }
        let next = real[index];
        if index == 0 {
            return Ok(next - 1.0);
        }
        let prev = real[index - 1];
        if next - prev >= MIN_GAP {
            return Ok(prev + (next - prev) / 2.0);
        }
        renumber(conn)?;
    }
    // After a renumbering every gap is at least 1: unreachable in practice.
    append_position(conn)
}

fn write(conn: &Connection, item: &TopItem, position: f64) -> AppResult<()> {
    match item {
        TopItem::Subject(id) => {
            conn.execute(
                "UPDATE subjects SET position = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, position, now_utc()],
            )?;
        }
        TopItem::Inbox => synced_settings::set_inbox_position(conn, position)?,
    }
    Ok(())
}

/// Rewrites the positions of every top-level subject (soft-deleted included) and of the
/// inbox when placed as 1, 2, 3… in `(position, inbox after ties, id)` order.
fn renumber(conn: &Connection) -> AppResult<()> {
    let mut items: Vec<(f64, bool, String)> = {
        let mut stmt = conn.prepare("SELECT position, id FROM subjects WHERE parent_id IS NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, false, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    if let Some(p) = synced_settings::inbox_position(conn)? {
        items.push((p, true, String::new()));
    }
    items.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    let now = now_utc();
    let mut stmt =
        conn.prepare("UPDATE subjects SET position = ?2, updated_at = ?3 WHERE id = ?1")?;
    for (i, (_, inbox, id)) in items.iter().enumerate() {
        let position = (i + 1) as f64;
        if *inbox {
            synced_settings::set_inbox_position(conn, position)?;
        } else {
            stmt.execute(params![id, position, now])?;
        }
    }
    log::debug!("renumbered {} top-level items", items.len());
    Ok(())
}

fn ensure_live_top_level(conn: &Connection, id: &str) -> AppResult<()> {
    let parent: Option<Option<String>> = conn
        .query_row(
            "SELECT parent_id FROM subjects WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    match parent {
        None => Err(AppError::NotFound(format!("subject {id}"))),
        Some(Some(_)) => Err(AppError::Invalid(format!(
            "subject {id} is a sub-project: not at the top level"
        ))),
        Some(None) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, subjects};
    use crate::model::{CreateSubjectInput, ReorderInput};

    fn insert(conn: &Connection, id: &str, position: f64) {
        conn.execute(
            "INSERT INTO subjects (id, name, color, position, created_at, updated_at) \
             VALUES (?1, ?1, 'violet', ?2, 'x', 'x')",
            params![id, position],
        )
        .expect("insert");
    }

    fn insert_child(conn: &Connection, id: &str, parent: &str, position: f64) {
        conn.execute(
            "INSERT INTO subjects (id, name, color, position, created_at, updated_at, \
             parent_id) VALUES (?1, ?1, 'violet', ?2, 'x', 'x', ?3)",
            params![id, position, parent],
        )
        .expect("insert child");
    }

    /// The order as short names: subject ids, `*` for « Sans projet ».
    fn names(conn: &Connection) -> Vec<String> {
        order(conn)
            .expect("order")
            .into_iter()
            .map(|i| match i {
                TopItem::Subject(id) => id,
                TopItem::Inbox => "*".into(),
            })
            .collect()
    }

    fn inbox(conn: &Connection) -> Option<f64> {
        synced_settings::inbox_position(conn).expect("inbox position")
    }

    fn abc() -> Connection {
        let conn = open_in_memory().expect("db");
        insert(&conn, "a", 1.0);
        insert(&conn, "b", 2.0);
        insert(&conn, "c", 3.0);
        conn
    }

    fn subject(id: &str) -> TopItem {
        TopItem::Subject(id.into())
    }

    #[test]
    fn unset_inbox_is_last() {
        let conn = open_in_memory().expect("db");
        assert_eq!(names(&conn), vec!["*"]);
        assert_eq!(inbox_index(&conn).expect("index"), 0);
        let conn = abc();
        assert_eq!(names(&conn), vec!["a", "b", "c", "*"]);
        assert_eq!(inbox_index(&conn).expect("index"), 3);
    }

    #[test]
    fn set_inbox_sorts_by_position_and_after_ties() {
        let conn = abc();
        let cases: &[(f64, &[&str], u32)] = &[
            (0.5, &["*", "a", "b", "c"], 0),
            (1.0, &["a", "*", "b", "c"], 1),
            (1.5, &["a", "*", "b", "c"], 1),
            (2.0, &["a", "b", "*", "c"], 2),
            (3.0, &["a", "b", "c", "*"], 3),
            (9.0, &["a", "b", "c", "*"], 3),
        ];
        for &(position, expected, index) in cases {
            synced_settings::set_inbox_position(&conn, position).expect("set");
            assert_eq!(names(&conn), expected, "{position}");
            assert_eq!(inbox_index(&conn).expect("index"), index, "{position}");
        }
    }

    #[test]
    fn order_ignores_soft_deleted_subjects_and_sub_projects() {
        let conn = abc();
        insert_child(&conn, "a1", "a", 0.1);
        conn.execute("UPDATE subjects SET deleted_at = 'x' WHERE id = 'b'", [])
            .expect("delete");
        synced_settings::set_inbox_position(&conn, 2.5).expect("set");
        assert_eq!(names(&conn), vec!["a", "*", "c"]);
        assert_eq!(inbox_index(&conn).expect("index"), 1);
    }

    #[test]
    fn append_position_counts_deleted_subjects_and_the_placed_inbox() {
        let conn = open_in_memory().expect("db");
        assert_eq!(append_position(&conn).expect("append"), 1.0);
        synced_settings::set_inbox_position(&conn, 4.0).expect("set");
        assert_eq!(append_position(&conn).expect("append"), 5.0);
        let conn = abc();
        assert_eq!(append_position(&conn).expect("append"), 4.0);
        conn.execute("UPDATE subjects SET deleted_at = 'x' WHERE id = 'c'", [])
            .expect("delete");
        insert_child(&conn, "a1", "a", 50.0);
        assert_eq!(append_position(&conn).expect("append"), 4.0);
        synced_settings::set_inbox_position(&conn, 7.5).expect("set");
        assert_eq!(append_position(&conn).expect("append"), 8.5);
        synced_settings::set_inbox_position(&conn, 0.5).expect("set");
        assert_eq!(append_position(&conn).expect("append"), 4.0);
    }

    #[test]
    fn moving_a_subject_before_or_onto_an_unset_inbox_does_not_write_it() {
        let conn = abc();
        // a to the slot of the unset inbox (index 2 among b, c, *): last subject.
        reorder(&conn, &subject("a"), 2).expect("reorder");
        assert_eq!(names(&conn), vec!["b", "c", "a", "*"]);
        assert_eq!(inbox(&conn), None);
        reorder(&conn, &subject("a"), 0).expect("reorder");
        assert_eq!(names(&conn), vec!["a", "b", "c", "*"]);
        reorder(&conn, &subject("c"), 1).expect("reorder");
        assert_eq!(names(&conn), vec!["a", "c", "b", "*"]);
        assert_eq!(inbox(&conn), None);
    }

    #[test]
    fn moving_a_subject_past_an_unset_inbox_places_the_inbox() {
        let conn = abc();
        reorder(&conn, &subject("a"), 3).expect("reorder");
        assert_eq!(names(&conn), vec!["b", "c", "*", "a"]);
        assert_eq!(inbox(&conn), Some(4.0));
        // From then on a new project goes after everything, the inbox included.
        let created = subjects::create(
            &conn,
            &CreateSubjectInput {
                name: "d".into(),
                color: None,
                root_path: None,
                parent_id: None,
            },
        )
        .expect("create");
        let mut expected = vec!["b", "c", "*", "a"];
        expected.push(&created.id);
        assert_eq!(names(&conn), expected);
    }

    #[test]
    fn a_new_project_lands_before_an_unset_inbox() {
        let conn = abc();
        let created = subjects::create(
            &conn,
            &CreateSubjectInput {
                name: "d".into(),
                color: None,
                root_path: None,
                parent_id: None,
            },
        )
        .expect("create");
        assert_eq!(names(&conn), vec!["a", "b", "c", &created.id, "*"]);
        assert_eq!(inbox(&conn), None);
    }

    #[test]
    fn moving_the_inbox_first_middle_and_last() {
        let conn = abc();
        reorder(&conn, &TopItem::Inbox, 0).expect("first");
        assert_eq!(names(&conn), vec!["*", "a", "b", "c"]);
        assert_eq!(inbox(&conn), Some(0.0));
        reorder(&conn, &TopItem::Inbox, 2).expect("middle");
        assert_eq!(names(&conn), vec!["a", "b", "*", "c"]);
        assert_eq!(inbox(&conn), Some(2.5));
        reorder(&conn, &TopItem::Inbox, 3).expect("last");
        assert_eq!(names(&conn), vec!["a", "b", "c", "*"]);
        assert_eq!(inbox(&conn), Some(4.0));
        reorder(&conn, &TopItem::Inbox, 99).expect("past the end");
        assert_eq!(names(&conn), vec!["a", "b", "c", "*"]);
        assert_eq!(inbox_index(&conn).expect("index"), 3);
    }

    #[test]
    fn moving_a_subject_around_a_placed_inbox() {
        let conn = abc();
        reorder(&conn, &TopItem::Inbox, 1).expect("inbox");
        assert_eq!(names(&conn), vec!["a", "*", "b", "c"]);
        reorder(&conn, &subject("c"), 1).expect("c before the inbox");
        assert_eq!(names(&conn), vec!["a", "c", "*", "b"]);
        reorder(&conn, &subject("a"), 3).expect("a last");
        assert_eq!(names(&conn), vec!["c", "*", "b", "a"]);
        reorder(&conn, &subject("a"), 0).expect("a first");
        assert_eq!(names(&conn), vec!["a", "c", "*", "b"]);
    }

    #[test]
    fn a_tiny_gap_renumbers_subjects_and_inbox_together() {
        let conn = open_in_memory().expect("db");
        insert(&conn, "a", 1.0);
        insert(&conn, "b", 1.0 + 1e-9);
        insert(&conn, "gone", 1.0 + 2e-9);
        conn.execute("UPDATE subjects SET deleted_at = 'x' WHERE id = 'gone'", [])
            .expect("delete");
        insert(&conn, "c", 7.0);
        // Tie with b: the inbox sorts after it.
        synced_settings::set_inbox_position(&conn, 1.0 + 1e-9).expect("set");
        assert_eq!(names(&conn), vec!["a", "b", "*", "c"]);
        reorder(&conn, &subject("c"), 1).expect("reorder");
        assert_eq!(names(&conn), vec!["a", "c", "b", "*"]);
        let positions: Vec<(String, f64)> = {
            let mut stmt = conn
                .prepare("SELECT id, position FROM subjects ORDER BY position")
                .expect("prepare");
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .expect("query");
            rows.collect::<Result<_, _>>().expect("rows")
        };
        // Renumbered a=1, b=2, inbox=3, gone=4, c=5, then c moved to 1.5.
        assert_eq!(
            positions,
            vec![
                ("a".into(), 1.0),
                ("c".into(), 1.5),
                ("b".into(), 2.0),
                ("gone".into(), 4.0)
            ]
        );
        assert_eq!(inbox(&conn), Some(3.0));
    }

    #[test]
    fn reorder_refuses_sub_projects_and_missing_subjects() {
        let conn = abc();
        insert_child(&conn, "a1", "a", 1.0);
        assert!(matches!(
            reorder(&conn, &subject("a1"), 0),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            reorder(&conn, &subject("missing"), 0),
            Err(AppError::NotFound(_))
        ));
        conn.execute("UPDATE subjects SET deleted_at = 'x' WHERE id = 'b'", [])
            .expect("delete");
        assert!(matches!(
            reorder(&conn, &subject("b"), 0),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn subjects_reorder_counts_the_inbox_at_top_level_only() {
        let conn = abc();
        insert_child(&conn, "a1", "a", 1.0);
        insert_child(&conn, "a2", "a", 2.0);
        reorder(&conn, &TopItem::Inbox, 1).expect("inbox");
        // Index 2 of [a, *, c] (b moving): after the inbox.
        subjects::reorder(
            &conn,
            &ReorderInput {
                id: "b".into(),
                index: 2,
            },
        )
        .expect("reorder b");
        assert_eq!(names(&conn), vec!["a", "*", "b", "c"]);
        // Sub-projects: among their siblings, the inbox does not count.
        subjects::reorder(
            &conn,
            &ReorderInput {
                id: "a2".into(),
                index: 0,
            },
        )
        .expect("reorder a2");
        assert_eq!(
            subjects::child_ids(&conn, "a").expect("children"),
            vec!["a2", "a1"]
        );
    }
}
