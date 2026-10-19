//! SQLite connection, migrations and repositories.

pub mod agent_sessions;
pub mod attachments;
pub mod backup;
pub mod board_columns;
#[cfg(test)]
mod demo_tests;
pub mod history;
pub mod journal;
pub mod notes;
pub mod positions;
pub mod questions;
pub mod relations;
pub mod sections;
pub mod settings;
pub mod subjects;
pub mod subtasks;
pub mod synced_settings;
pub mod tasks;
pub mod terminals;
#[cfg(test)]
pub mod test_support;
pub mod time_segments;
pub mod top_level;
pub mod trash;
pub mod v1_upgrade;
#[cfg(test)]
mod v2_schema_tests;
pub mod workdir;
pub mod workspace;

/// SQL condition (on the alias `t`) of the open tasks a list shows at its top level:
/// top-level tasks, and the open children of a completed parent, which would show nowhere
/// else (the parent sits folded in « Terminées »). Completing a parent completes its
/// children, but a child reopened later, migrated data or a subtask added to a completed
/// task can still be open under it.
macro_rules! listed_open_sql {
    () => {
        "(t.parent_id IS NULL OR EXISTS (SELECT 1 FROM tasks p \
         WHERE p.id = t.parent_id AND p.completed_at IS NOT NULL))"
    };
}
pub(crate) use listed_open_sql;

use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

use crate::error::{AppError, AppResult};

const MIGRATIONS_SLICE: &[M<'static>] = &[
    M::up(include_str!("../../migrations/0001_init.sql")),
    // Rebuilds `subjects`: runs with foreign keys off, checked before commit.
    M::up(include_str!(
        "../../migrations/0002_optional_folder_soft_delete.sql"
    ))
    .foreign_key_check(),
    M::up(include_str!("../../migrations/0003_session_question.sql")),
    M::up(include_str!(
        "../../migrations/0004_session_trace_backfill.sql"
    )),
    // Subtasks become child tasks; checks the new `parent_id` references.
    M::up(include_str!(
        "../../migrations/0005_child_tasks_priority.sql"
    ))
    .foreign_key_check(),
    // Completed parents complete their open children.
    M::up(include_str!(
        "../../migrations/0006_complete_children_of_completed_parents.sql"
    )),
    M::up(include_str!(
        "../../migrations/0007_session_title_summary.sql"
    )),
    // Sub-projects; checks the new `parent_id` references.
    M::up(include_str!("../../migrations/0008_sub_projects.sql")).foreign_key_check(),
    M::up(include_str!("../../migrations/0009_reset_folder_links.sql")),
    // Change tracking for the sync.
    M::up(include_str!("../../migrations/0010_sync.sql")),
    // Synced settings (« Sans projet »'s position) and the outbox accepting them
    //.
    M::up(include_str!("../../migrations/0011_synced_settings.sql")),
    // Taido V2: time segments, relations, attachments.
    M::up(include_str!("../../migrations/0012_v2_foundations.sql")),
    // Taido V2.1: the chrono's stop reasons.
    M::up(include_str!(
        "../../migrations/0013_segment_stop_reasons.sql"
    )),
    // Taido V2.2: kanban columns of progress.
    M::up(include_str!("../../migrations/0014_board_columns.sql")),
    // Taido V2.2 bis: groups replace sub-projects; checks the new `parent_id` references.
    M::up(include_str!("../../migrations/0015_project_groups.sql")).foreign_key_check(),
    // Taido V2.7: the V2 tables join the sync (protocol 3).
    M::up(include_str!("../../migrations/0016_sync_v2.sql")),
    // Taido V2.7 bis: attachment files through the server.
    M::up(include_str!("../../migrations/0017_attachment_files.sql")),
    // Taido V2.7 bis: whether an attachment's file may be on another device (final fixes).
    M::up(include_str!("../../migrations/0018_attachment_shared.sql")),
    // Codex as a second agent: the agent of each session.
    M::up(include_str!("../../migrations/0019_agents.sql")),
    // The tab's context gauge: how full each conversation's context is (JSON).
    M::up(include_str!("../../migrations/0020_context_usage.sql")),
    // Project notebook: note groups and pages, page images; rebuilds `attachments`, the outbox and every trigger.
    M::up(include_str!("../../migrations/0021_notes.sql")).foreign_key_check(),
    // « Demander au projet »: the questions asked to a project (local only).
    M::up(include_str!("../../migrations/0022_project_questions.sql")),
];
pub(crate) const MIGRATIONS: Migrations<'static> = Migrations::from_slice(MIGRATIONS_SLICE);

/// Opens (or creates) the database file, sets pragmas and runs migrations.
pub fn open(path: &Path) -> AppResult<Connection> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&mut conn)?;
    configure(&conn)?;
    Ok(conn)
}

/// Runs the pending migrations with foreign keys off: a table rebuild (migration 0002) must
/// not cascade its `DROP TABLE` to the referencing rows. The pragma cannot change inside the
/// migration transaction, hence here. Migrations that rebuild tables check the keys
/// (`PRAGMA foreign_key_check`) before committing.
fn migrate(conn: &mut Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let result = MIGRATIONS.to_latest(conn);
    // Restored by `configure` right after; also restored here if the migration failed.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(result?)
}

/// In-memory database for tests, fully migrated. The language is pinned to French, the one the
/// existing tests assert; the others set `en` (or clear it) on purpose.
#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    migrate(&mut conn)?;
    configure(&conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('language', '\"fr\"')",
        [],
    )?;
    Ok(conn)
}

/// New identifier: UUID v7 (time ordered) as text.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Current instant, ISO 8601 UTC with milliseconds and a `Z` suffix.
pub fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Trims `value` and rejects it when empty. `what` names the field in the error.
pub fn non_empty(value: &str, what: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid(format!("{what} must not be empty")));
    }
    Ok(trimmed.to_string())
}

fn configure(conn: &Connection) -> AppResult<()> {
    // Has no effect inside a migration transaction: must be set on every connection.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_valid() {
        assert!(MIGRATIONS.validate().is_ok());
    }

    #[test]
    fn in_memory_db_has_schema_and_foreign_keys() {
        let conn = open_in_memory().expect("db");
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .expect("pragma");
        assert_eq!(fk, 1);
        let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN \
                 ('subjects','sections','tasks','terminals','agent_sessions', \
                  'journal_entries','hook_events','settings')",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(tables, 8);
    }

    /// Migration 0002 rebuilds `subjects` on a database created by 0001: every row and every
    /// reference survives, foreign keys stay enforced and `root_path` accepts NULL.
    #[test]
    fn migration_0002_keeps_existing_data() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("old.sqlite3");
        {
            let mut conn = Connection::open(&path).expect("open");
            conn.pragma_update(None, "foreign_keys", "ON").expect("fk");
            MIGRATIONS.to_version(&mut conn, 1).expect("migrate to v1");
            conn.execute_batch(
                "INSERT INTO subjects VALUES ('s1','Alpha','teal','/tmp/a',1,'t','t');
                 INSERT INTO subjects VALUES ('s2','Beta','pink','/tmp/b',2,'t','t');
                 INSERT INTO sections VALUES ('sec1','s1','Front','web',1,'t','t');
                 INSERT INTO tasks (id, subject_id, section_id, title, position, created_at,
                   updated_at) VALUES ('t1','s1','sec1','In section',1,'t','t');
                 INSERT INTO tasks (id, subject_id, section_id, title, position, created_at,
                   updated_at) VALUES ('t2','s2',NULL,'Loose',1,'t','t');
                 INSERT INTO tasks (id, subject_id, section_id, title, position, created_at,
                   updated_at) VALUES ('t3',NULL,NULL,'Inbox',1,'t','t');
                 INSERT INTO subtasks VALUES ('st1','t1','sub',0,1,'t','t');
                 INSERT INTO journal_entries VALUES ('j1','t1',NULL,'created','','t');",
            )
            .expect("seed v1");
        }
        let conn = open(&path).expect("open and migrate");
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).expect(sql) };
        assert_eq!(count("SELECT COUNT(*) FROM subjects"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM sections"), 1);
        // The subtask became a child task (migration 0005).
        assert_eq!(count("SELECT COUNT(*) FROM tasks"), 4);
        assert_eq!(
            count("SELECT COUNT(*) FROM tasks WHERE parent_id = 't1'"),
            1
        );
        assert_eq!(count("SELECT COUNT(*) FROM journal_entries"), 1);
        assert_eq!(count("PRAGMA foreign_keys"), 1);
        let root: Option<String> = conn
            .query_row("SELECT root_path FROM subjects WHERE id = 's1'", [], |r| {
                r.get(0)
            })
            .expect("root");
        // Migration 0009 forgets hand-made folder links (the startup rebuilds them).
        assert_eq!(root, None);
        conn.execute("UPDATE subjects SET root_path = NULL WHERE id = 's1'", [])
            .expect("root_path is nullable");
        // References still point at the rebuilt table and still cascade.
        let bad = conn.execute(
            "INSERT INTO tasks (id, subject_id, title, position, created_at, updated_at) \
             VALUES ('x','missing','X',1,'t','t')",
            [],
        );
        assert!(bad.is_err(), "foreign key to subjects is enforced");
        conn.execute("DELETE FROM subjects WHERE id = 's1'", [])
            .expect("delete");
        assert_eq!(count("SELECT COUNT(*) FROM sections"), 0);
        // t1 and its child went with the subject.
        assert_eq!(count("SELECT COUNT(*) FROM tasks"), 2);
        assert_eq!(
            count("SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL"),
            2
        );
    }

    /// Migration 0005 turns every subtask into a child task of its parent: same id, title
    /// and order, done state (completed at its last toggle), the parent's place and deletion
    /// stamp; the `subtasks` table is gone.
    #[test]
    fn migration_0005_converts_subtasks_into_child_tasks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("v4.sqlite3");
        {
            let mut conn = Connection::open(&path).expect("open");
            MIGRATIONS.to_version(&mut conn, 4).expect("migrate to v4");
            conn.execute_batch(
                "INSERT INTO subjects (id, name, color, root_path, position, created_at,
                   updated_at) VALUES ('s1','Alpha','teal','/tmp/a',1,'t','t');
                 INSERT INTO sections VALUES ('sec1','s1','Front','web',1,'t','t');
                 INSERT INTO tasks (id, subject_id, section_id, title, position, created_at,
                   updated_at) VALUES ('p1','s1','sec1','Parent',1,'c0','u0');
                 INSERT INTO tasks (id, subject_id, section_id, title, position, created_at,
                   updated_at, deleted_at) VALUES ('p2',NULL,NULL,'Gone',2,'c0','u0','d0');
                 INSERT INTO subtasks VALUES ('st-b','p1','second',1,2.5,'c2','u2');
                 INSERT INTO subtasks VALUES ('st-a','p1','first',0,1,'c1','u1');
                 INSERT INTO subtasks VALUES ('st-c','p1','third',0,7,'c3','u3');
                 INSERT INTO subtasks VALUES ('st-x','p2','orphan',0,1,'c4','u4');",
            )
            .expect("seed v4");
        }
        let conn = open(&path).expect("open and migrate");
        let children = |parent: &str| -> Vec<ChildRow> {
            let mut stmt = conn
                .prepare(
                    "SELECT id, subject_id, section_id, title, completed_at, position, \
                     created_at, updated_at, deleted_at, priority FROM tasks \
                     WHERE parent_id = ?1 ORDER BY position",
                )
                .expect("prepare");
            let rows = stmt
                .query_map([parent], |r| {
                    Ok(ChildRow {
                        id: r.get(0)?,
                        place: (r.get(1)?, r.get(2)?),
                        title: r.get(3)?,
                        completed_at: r.get(4)?,
                        position: r.get(5)?,
                        stamps: (r.get(6)?, r.get(7)?),
                        deleted_at: r.get(8)?,
                        priority: r.get(9)?,
                    })
                })
                .expect("query");
            rows.collect::<Result<_, _>>().expect("rows")
        };
        let expected = |id: &str, title: &str, done: Option<&str>, position: f64, n: u8| ChildRow {
            id: id.into(),
            place: (Some("s1".into()), Some("sec1".into())),
            title: title.into(),
            completed_at: done.map(String::from),
            position,
            stamps: (format!("c{n}"), format!("u{n}")),
            deleted_at: None,
            priority: 1,
        };
        assert_eq!(
            children("p1"),
            vec![
                expected("st-a", "first", None, 1.0, 1),
                expected("st-b", "second", Some("u2"), 2.5, 2),
                expected("st-c", "third", None, 7.0, 3),
            ]
        );
        let orphan = children("p2");
        assert_eq!(orphan.len(), 1);
        assert_eq!(orphan[0].id, "st-x");
        assert_eq!(orphan[0].place, (None, None));
        assert_eq!(
            orphan[0].deleted_at.as_deref(),
            Some("d0"),
            "deleted with its parent"
        );
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).expect(sql) };
        assert_eq!(
            count("SELECT COUNT(*) FROM sqlite_master WHERE name = 'subtasks'"),
            0
        );
        assert_eq!(count("SELECT priority FROM tasks WHERE id = 'p1'"), 1);
        assert!(
            conn.execute("UPDATE tasks SET priority = 5 WHERE id = 'p1'", [])
                .is_err(),
            "priority is 1 to 4"
        );
        // Children go with their parent when it is purged.
        conn.execute("DELETE FROM tasks WHERE id = 'p1'", [])
            .expect("delete");
        assert!(children("p1").is_empty());
        assert_eq!(count("SELECT COUNT(*) FROM tasks"), 2);
    }

    #[test]
    fn migration_0006_completes_open_children_of_completed_parents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("v5.sqlite3");
        {
            let mut conn = Connection::open(&path).expect("open");
            MIGRATIONS.to_version(&mut conn, 5).expect("migrate to v5");
            conn.execute_batch(
                "INSERT INTO tasks (id, title, position, created_at, updated_at, completed_at)
                   VALUES ('done','Done',1,'c','u','2026-09-01T10:00:00.000Z');
                 INSERT INTO tasks (id, title, position, created_at, updated_at)
                   VALUES ('open','Open',2,'c','u');
                 INSERT INTO tasks (id, parent_id, title, position, created_at, updated_at)
                   VALUES ('a','done','a',1,'c','u'), ('b','open','b',1,'c','u');
                 INSERT INTO tasks (id, parent_id, title, position, created_at, updated_at,
                   completed_at) VALUES ('c','done','c',2,'c','u','2026-08-01T10:00:00.000Z');",
            )
            .expect("seed v5");
        }
        let conn = open(&path).expect("open and migrate");
        let done = |id: &str| -> Option<String> {
            conn.query_row("SELECT completed_at FROM tasks WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .expect(id)
        };
        assert_eq!(done("a").as_deref(), Some("2026-09-01T10:00:00.000Z"));
        assert_eq!(done("b"), None, "an open parent keeps its open children");
        assert_eq!(done("c").as_deref(), Some("2026-08-01T10:00:00.000Z"));
    }

    /// Migration 0008 adds `subjects.parent_id` in place on a database at schema 0007: every
    /// project, section and task survives as a top-level project, references still hold and
    /// the new column is a checked reference.
    #[test]
    fn migration_0008_adds_sub_projects_without_touching_data() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("v7.sqlite3");
        {
            let mut conn = Connection::open(&path).expect("open");
            MIGRATIONS.to_version(&mut conn, 7).expect("migrate to v7");
            conn.execute_batch(
                "INSERT INTO subjects (id, name, color, root_path, position, created_at,
                   updated_at) VALUES ('s1','Alpha','teal','/tmp/a',1,'t','t'),
                   ('s2','Beta','pink',NULL,2,'t','t');
                 INSERT INTO sections VALUES ('sec1','s1','Front','web',1,'t','t');
                 INSERT INTO tasks (id, subject_id, section_id, title, position, created_at,
                   updated_at) VALUES ('t1','s1','sec1','In section',1,'t','t'),
                   ('t2','s2',NULL,'Loose',1,'t','t');",
            )
            .expect("seed v7");
        }
        let conn = open(&path).expect("open and migrate");
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).expect(sql) };
        assert_eq!(
            count("SELECT COUNT(*) FROM subjects WHERE parent_id IS NULL"),
            2
        );
        assert_eq!(count("SELECT COUNT(*) FROM sections"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM tasks"), 2);
        let listed: Vec<(String, Option<String>, f64)> = subjects::list(&conn)
            .expect("list")
            .into_iter()
            .map(|s| (s.name, s.parent_id, s.position))
            .collect();
        assert_eq!(
            listed,
            vec![("Alpha".into(), None, 1.0), ("Beta".into(), None, 2.0)]
        );
        assert!(
            conn.execute(
                "UPDATE subjects SET parent_id = 'missing' WHERE id = 's2'",
                []
            )
            .is_err(),
            "parent_id references subjects"
        );
        conn.execute("UPDATE subjects SET parent_id = 's1' WHERE id = 's2'", [])
            .expect("sub-project");
        // Still referenced by sections and tasks; a purged parent takes its sub-projects.
        conn.execute("DELETE FROM subjects WHERE id = 's1'", [])
            .expect("delete");
        assert_eq!(count("SELECT COUNT(*) FROM subjects"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM sections"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM tasks"), 0);
        assert_eq!(
            count("SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_subjects_parent'"),
            1
        );
    }

    #[derive(Debug, PartialEq)]
    struct ChildRow {
        id: String,
        place: (Option<String>, Option<String>),
        title: String,
        completed_at: Option<String>,
        position: f64,
        stamps: (String, String),
        deleted_at: Option<String>,
        priority: i64,
    }
}
