//! Relations between tasks (Taido V2.3): « Bloque » (read backwards:
//! « Bloquée par ») and « Liée à » (symmetric), across projects. A task is blocked while one
//! of the tasks blocking it is open. Purging a task removes its relations (cascade); a
//! soft-deleted task's relations are hidden.

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{new_id, now_utc, tasks};
use crate::error::{AppError, AppResult};
use crate::model::{AddRelationInput, RelatedTask, RelationKind, TaskRelations};

/// SQL (on the alias `t`) of the number of open tasks `t` blocks.
pub const BLOCKS_SQL: &str = "(SELECT COUNT(*) FROM task_relations r JOIN tasks o \
    ON o.id = r.to_task_id WHERE r.from_task_id = t.id AND r.kind = 'blocks' \
    AND r.deleted_at IS NULL AND o.deleted_at IS NULL AND o.completed_at IS NULL)";
/// SQL (on the alias `t`) of the title of the first open task blocking `t`.
pub const BLOCKED_BY_SQL: &str = "(SELECT o.title FROM task_relations r JOIN tasks o \
    ON o.id = r.from_task_id WHERE r.to_task_id = t.id AND r.kind = 'blocks' \
    AND r.deleted_at IS NULL AND o.deleted_at IS NULL AND o.completed_at IS NULL \
    ORDER BY r.created_at LIMIT 1)";

/// SQL (on the alias `t`) of the number of open tasks blocking `t`.
pub const BLOCKED_BY_COUNT_SQL: &str = "(SELECT COUNT(*) FROM task_relations r JOIN tasks o \
    ON o.id = r.from_task_id WHERE r.to_task_id = t.id AND r.kind = 'blocks' \
    AND r.deleted_at IS NULL AND o.deleted_at IS NULL AND o.completed_at IS NULL)";
/// SQL (on the alias `t`) of the number of tasks related to `t` (« Liée à », either
/// direction), completed ones included: the link stays meaningful once the other is done.
pub const RELATED_SQL: &str = "(SELECT COUNT(*) FROM task_relations r JOIN tasks o \
    ON o.id = CASE WHEN r.from_task_id = t.id THEN r.to_task_id ELSE r.from_task_id END \
    WHERE (r.from_task_id = t.id OR r.to_task_id = t.id) AND r.kind = 'relates_to' \
    AND r.deleted_at IS NULL AND o.deleted_at IS NULL)";

/// « Bloque », « Bloquée par » or « Liée à » from `input.task_id` to `input.other_id`.
pub fn add(conn: &Connection, input: &AddRelationInput) -> AppResult<()> {
    tasks::ensure_exists(conn, &input.task_id)?;
    tasks::ensure_exists(conn, &input.other_id)?;
    if input.task_id == input.other_id {
        return Err(AppError::Invalid("a task cannot relate to itself".into()));
    }
    let (from, to, kind) = match input.kind {
        RelationKind::Blocks => (&input.task_id, &input.other_id, "blocks"),
        RelationKind::BlockedBy => (&input.other_id, &input.task_id, "blocks"),
        RelationKind::RelatesTo => (&input.task_id, &input.other_id, "relates_to"),
    };
    // Already there, in either direction (a « Liée à » is symmetric; A blocks B and B blocks
    // A would block both forever).
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM task_relations WHERE deleted_at IS NULL AND \
             ((from_task_id = ?1 AND to_task_id = ?2) OR (from_task_id = ?2 AND to_task_id = ?1)) \
             AND kind = ?3",
            params![from, to, kind],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_some() {
        return Err(AppError::Invalid("these tasks are already related".into()));
    }
    let now = now_utc();
    conn.execute(
        "INSERT INTO task_relations (id, from_task_id, to_task_id, kind, created_at, \
         updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![new_id(), from, to, kind, now],
    )?;
    Ok(())
}

/// Removes a relation; returns the two tasks.
pub fn delete(conn: &Connection, id: &str) -> AppResult<(String, String)> {
    let pair: Option<(String, String)> = conn
        .query_row(
            "SELECT from_task_id, to_task_id FROM task_relations \
             WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let pair = pair.ok_or_else(|| AppError::NotFound(format!("relation {id}")))?;
    conn.execute(
        "UPDATE task_relations SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
        params![id, now_utc()],
    )?;
    Ok(pair)
}

/// The panel's « Relations » of a task.
pub fn of_task(conn: &Connection, task_id: &str) -> AppResult<TaskRelations> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.kind, r.from_task_id = ?1, o.id, o.title, s.name, \
         o.completed_at IS NOT NULL, p.title \
         FROM task_relations r \
         JOIN tasks o ON o.id = CASE WHEN r.from_task_id = ?1 THEN r.to_task_id \
           ELSE r.from_task_id END \
         LEFT JOIN subjects s ON s.id = o.subject_id \
         LEFT JOIN tasks p ON p.id = o.parent_id \
         WHERE (r.from_task_id = ?1 OR r.to_task_id = ?1) AND r.deleted_at IS NULL \
           AND o.deleted_at IS NULL \
         ORDER BY r.created_at, r.id",
    )?;
    let rows = stmt.query_map([task_id], |r| {
        Ok((
            r.get::<_, String>(1)?,
            r.get::<_, bool>(2)?,
            RelatedTask {
                relation_id: r.get(0)?,
                task_id: r.get(3)?,
                title: r.get(4)?,
                parent_title: r.get(7)?,
                project: r.get(5)?,
                completed: r.get(6)?,
            },
        ))
    })?;
    let mut out = TaskRelations {
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        related: Vec::new(),
    };
    for row in rows {
        let (kind, outgoing, related) = row?;
        match (kind.as_str(), outgoing) {
            ("blocks", true) => out.blocks.push(related),
            ("blocks", false) => out.blocked_by.push(related),
            _ => out.related.push(related),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_in_memory, test_support};
    use crate::model::SetCompletedInput;

    fn relate(conn: &Connection, a: &str, b: &str, kind: RelationKind) -> AppResult<()> {
        add(
            conn,
            &AddRelationInput {
                task_id: a.into(),
                other_id: b.into(),
                kind,
            },
        )
    }

    #[test]
    fn blocks_shows_on_both_sides_across_projects() {
        let conn = open_in_memory().expect("db");
        let p1 = test_support::subject(&conn, "Summit Events");
        let p2 = test_support::subject(&conn, "Acme Studio");
        let mail = test_support::task(&conn, "Modèle d'e-mail", Some(&p1), None);
        let relances = test_support::task(&conn, "Relances", Some(&p2), None);
        let call = test_support::task(&conn, "Appel", Some(&p1), None);
        relate(&conn, &relances, &mail, RelationKind::BlockedBy).expect("blocked by");
        relate(&conn, &mail, &call, RelationKind::RelatesTo).expect("related");
        let m = of_task(&conn, &mail).expect("mail");
        assert_eq!(m.blocks[0].title, "Relances");
        assert_eq!(m.blocks[0].project.as_deref(), Some("Acme Studio"));
        assert_eq!(m.related[0].title, "Appel");
        let r = of_task(&conn, &relances).expect("relances");
        assert_eq!(r.blocked_by[0].title, "Modèle d'e-mail");
        assert_eq!(
            of_task(&conn, &call).expect("call").related[0].title,
            "Modèle d'e-mail"
        );
        // Rows: « bloque 1 », « bloquée par : Modèle d'e-mail », until it is done.
        let row = |id: &str| -> (i64, Option<String>) {
            conn.query_row(
                &format!("SELECT {BLOCKS_SQL}, {BLOCKED_BY_SQL} FROM tasks t WHERE t.id = ?1"),
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row")
        };
        assert_eq!(row(&mail), (1, None));
        assert_eq!(row(&relances), (0, Some("Modèle d'e-mail".into())));
        tasks::set_completed(
            &conn,
            &SetCompletedInput {
                id: mail.clone(),
                completed: true,
            },
        )
        .expect("done");
        assert_eq!(row(&relances), (0, None));
        assert!(of_task(&conn, &relances).expect("r").blocked_by[0].completed);
    }

    #[test]
    fn row_counts_open_blockers_and_every_related_task() {
        let conn = open_in_memory().expect("db");
        let t = test_support::task(&conn, "Guide", None, None);
        let b1 = test_support::task(&conn, "Formation", None, None);
        let b2 = test_support::task(&conn, "Maquette", None, None);
        let l1 = test_support::task(&conn, "Note", None, None);
        let l2 = test_support::task(&conn, "Vidéo", None, None);
        relate(&conn, &t, &b1, RelationKind::BlockedBy).expect("b1");
        relate(&conn, &b2, &t, RelationKind::Blocks).expect("b2");
        relate(&conn, &t, &l1, RelationKind::RelatesTo).expect("l1");
        relate(&conn, &l2, &t, RelationKind::RelatesTo).expect("l2");
        let counts = |id: &str| -> (i64, i64) {
            conn.query_row(
                &format!(
                    "SELECT {BLOCKED_BY_COUNT_SQL}, {RELATED_SQL} FROM tasks t WHERE t.id = ?1"
                ),
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row")
        };
        assert_eq!(counts(&t), (2, 2));
        assert_eq!(counts(&l2), (0, 1));
        // A done blocker no longer counts; a done related task still does.
        for id in [&b1, &l1] {
            tasks::set_completed(
                &conn,
                &SetCompletedInput {
                    id: id.clone(),
                    completed: true,
                },
            )
            .expect("done");
        }
        assert_eq!(counts(&t), (1, 2));
    }

    #[test]
    fn refuses_itself_duplicates_and_cycles_then_deletes() {
        let conn = open_in_memory().expect("db");
        let a = test_support::task(&conn, "A", None, None);
        let b = test_support::task(&conn, "B", None, None);
        assert!(relate(&conn, &a, &a, RelationKind::Blocks).is_err());
        relate(&conn, &a, &b, RelationKind::Blocks).expect("blocks");
        assert!(relate(&conn, &a, &b, RelationKind::Blocks).is_err());
        assert!(
            relate(&conn, &b, &a, RelationKind::Blocks).is_err(),
            "cycle"
        );
        relate(&conn, &b, &a, RelationKind::RelatesTo).expect("also related");
        assert!(relate(&conn, &a, &b, RelationKind::RelatesTo).is_err());
        let id = of_task(&conn, &a).expect("a").blocks[0].relation_id.clone();
        assert_eq!(delete(&conn, &id).expect("delete"), (a.clone(), b.clone()));
        assert!(of_task(&conn, &a).expect("a").blocks.is_empty());
        assert_eq!(of_task(&conn, &a).expect("a").related[0].task_id, b);
    }

    #[test]
    fn cross_project_relation_needs_no_plan() {
        let conn = open_in_memory().expect("db");
        let p1 = test_support::subject(&conn, "One");
        let p2 = test_support::subject(&conn, "Two");
        let a = test_support::task(&conn, "A", Some(&p1), None);
        let b = test_support::task(&conn, "B", Some(&p2), None);
        relate(&conn, &a, &b, RelationKind::Blocks).expect("link between projects");
        assert_eq!(of_task(&conn, &a).expect("a").blocks[0].task_id, b);
    }
}
