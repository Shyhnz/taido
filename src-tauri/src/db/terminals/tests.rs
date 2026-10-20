use super::*;
use crate::db::open_in_memory;
use crate::db::test_support::{section, sub_project, subject, task};

fn state_of(conn: &Connection, session_id: &str) -> (String, Option<String>) {
    conn.query_row(
        "SELECT state, ended_at FROM agent_sessions WHERE id = ?1",
        [session_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .expect("session")
}

fn terminal_row(conn: &Connection, id: &str) -> (Option<String>, Option<i32>, bool) {
    conn.query_row(
        "SELECT closed_at, exit_code, closed_by_user FROM terminals WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .expect("terminal")
}

fn open_claude(conn: &Connection, task_id: &str, term: &str, session: &str) {
    insert(
        conn,
        &NewTerminal {
            id: term,
            task_id,
            kind: TerminalKind::Agent,
            command: None,
            cwd: "/tmp",
            opened_at: "2026-10-03T10:00:00.000Z",
        },
        Some(&NewSession {
            id: session,
            task_id,
            conversation_id: &format!("uuid-{session}"),
            agent: crate::model::Agent::Claude,
            terminal_id: term,
            permission_mode: Some(PermissionMode::Plan),
            add_task_context: true,
            at: "2026-10-03T10:00:00.000Z",
        }),
    )
    .expect("insert");
}

#[test]
fn insert_creates_a_starting_session_and_counts_on_the_row() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "p");
    let t = task(&conn, "T", Some(&s), None);
    open_claude(&conn, &t, "term-1", "s-1");
    assert_eq!(state_of(&conn, "s-1"), ("starting".into(), None));
    let mode: String = conn
        .query_row("SELECT permission_mode FROM agent_sessions", [], |r| {
            r.get(0)
        })
        .expect("mode");
    assert_eq!(mode, "plan");
    let rows =
        crate::views::rows::load(&conn, crate::views::rows::Filter::All { completed: false })
            .expect("rows");
    assert_eq!(rows[0].open_terminals, 1);
}

#[test]
fn exit_closes_the_terminal_and_ends_its_session() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    assert!(!mark_exited(&conn, "term-1", Some(0)).expect("exit"));
    let (closed, code, by_user) = terminal_row(&conn, "term-1");
    assert!(closed.is_some());
    assert_eq!(code, Some(0));
    assert!(!by_user);
    assert!(state_of(&conn, "s-1").1.is_some());
}

#[test]
fn closed_by_user_is_marked_before_the_exit() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    mark_closed_by_user(&conn, "term-1").expect("close");
    let (closed_at, _, by_user) = terminal_row(&conn, "term-1");
    assert!(by_user);
    assert!(mark_exited(&conn, "term-1", None).expect("exit"));
    let (after, code, _) = terminal_row(&conn, "term-1");
    assert_eq!(after, closed_at, "the first closing instant is kept");
    assert_eq!(code, None);
}

#[test]
fn quitting_pauses_live_sessions_before_stopping() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    open_claude(&conn, &t, "term-2", "s-2");
    mark_exited(&conn, "term-2", Some(0)).expect("exit");
    assert_eq!(pause_all_open(&conn).expect("pause"), 1);
    assert_eq!(state_of(&conn, "s-1").0, "paused");
    assert_eq!(
        state_of(&conn, "s-2").0,
        "starting",
        "an ended session is left alone"
    );
    assert!(terminal_row(&conn, "term-1").2);
    // The exit that follows does not undo the pause.
    mark_exited(&conn, "term-1", None).expect("exit");
    assert_eq!(state_of(&conn, "s-1").0, "paused");
}

#[test]
fn orphans_at_startup_become_history() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    assert_eq!(close_orphans(&conn).expect("orphans"), 1);
    // No tab after a restart: history, not a « ! ».
    let (state, ended) = state_of(&conn, "s-1");
    assert_eq!(state, "paused");
    assert!(ended.is_some());
    assert!(terminal_row(&conn, "term-1").0.is_some());
    assert_eq!(close_orphans(&conn).expect("again"), 0);
}

#[test]
fn delete_unstarted_removes_both_rows() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    delete_unstarted(&conn, "term-1").expect("delete");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM agent_sessions", [], |r| r.get(0))
        .expect("count");
    assert_eq!(n, 0);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM terminals", [], |r| r.get(0))
        .expect("count");
    assert_eq!(n, 0);
}

#[test]
fn hook_events_are_logged_and_purged() {
    let conn = open_in_memory().expect("db");
    log_hook_event(&conn, Some("term-1"), "Stop", "{}").expect("log");
    conn.execute(
        "UPDATE hook_events SET received_at = '2026-09-01T00:00:00.000Z'",
        [],
    )
    .expect("backdate");
    log_hook_event(&conn, None, "Stop", "{}").expect("log");
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-03T00:00:00Z")
        .expect("date")
        .with_timezone(&chrono::Utc);
    assert_eq!(purge_hook_events(&conn, now).expect("purge"), 1);
}

#[test]
fn hook_events_are_read_newest_first() {
    let conn = open_in_memory().expect("db");
    log_hook_event(&conn, Some("term-1"), "SessionStart", r#"{"a":1}"#).expect("log");
    log_hook_event(&conn, None, "Stop", r#"{"b":2}"#).expect("log");
    log_hook_event(&conn, Some("term-1"), "unknown", "not json").expect("log");
    let all = hook_events(&conn, 10).expect("read");
    let names: Vec<&str> = all.iter().map(|e| e.event.as_str()).collect();
    assert_eq!(names, ["unknown", "Stop", "SessionStart"]);
    assert!(all[0].id > all[1].id);
    assert_eq!(all[0].payload, "not json");
    assert_eq!(all[1].terminal_id, None);
    assert_eq!(all[2].terminal_id.as_deref(), Some("term-1"));
    assert_eq!(hook_events(&conn, 2).expect("read").len(), 2);
    assert!(hook_events(&conn, 0).expect("read").is_empty());
}

#[test]
fn quitting_clears_the_permission_queue_and_keeps_crashes() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    open_claude(&conn, &t, "term-2", "s-2");
    conn.execute(
        "UPDATE agent_sessions SET state = 'waiting', waiting_kind = 'permission', \
         pending_permission = '{\"tool_name\":\"Bash\",\"summary\":\"Commande : ls\"}' \
         WHERE id = 's-1'",
        [],
    )
    .expect("waiting");
    conn.execute(
        "UPDATE agent_sessions SET state = 'crashed' WHERE id = 's-2'",
        [],
    )
    .expect("crashed");
    pause_all_open(&conn).expect("pause");
    let (kind, pending): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT waiting_kind, pending_permission FROM agent_sessions WHERE id = 's-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("row");
    assert_eq!(state_of(&conn, "s-1").0, "paused");
    assert_eq!((kind, pending), (None, None));
    // Quitting keeps a crash as it is; the next startup settles it as history.
    assert_eq!(state_of(&conn, "s-2").0, "crashed");
    assert_eq!(settle_stale_sessions(&conn).expect("startup"), 1);
    assert_eq!(state_of(&conn, "s-2").0, "paused");
}

fn folder_of(conn: &Connection, task_id: &str) -> (Option<String>, WorkdirSource) {
    let d = tasks::detail(conn, task_id).expect("detail");
    let w = d.workdir.expect("workdir");
    (Some(w.path), w.source)
}

#[test]
fn set_task_folder_picks_the_right_level() {
    let conn = open_in_memory().expect("db");
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("root");
    let inside = root.join("app");
    let elsewhere = dir.path().join("other");
    for d in [&root, &inside, &elsewhere] {
        std::fs::create_dir_all(d).expect("mkdir");
    }
    let p = |d: &std::path::Path| d.to_string_lossy().into_owned();

    // Inbox task: the task's override.
    let inbox = task(&conn, "Inbox", None, None);
    set_task_folder(
        &conn,
        &SetTaskFolderInput {
            task_id: inbox.clone(),
            path: p(&elsewhere),
        },
    )
    .expect("inbox");
    assert_eq!(
        folder_of(&conn, &inbox),
        (Some(p(&elsewhere)), WorkdirSource::Task)
    );

    // Project without folder: the project's folder.
    let s = subjects::create(
        &conn,
        &crate::model::CreateSubjectInput {
            name: "P".into(),
            color: None,
            root_path: None,
            parent_id: None,
        },
    )
    .expect("subject")
    .id;
    let t = task(&conn, "T", Some(&s), None);
    set_task_folder(
        &conn,
        &SetTaskFolderInput {
            task_id: t.clone(),
            path: p(&root),
        },
    )
    .expect("project");
    assert_eq!(
        subjects::get(&conn, &s).expect("s").root_path,
        Some(p(&root))
    );

    // Inherited from a section: inside the project folder → the section's sub-folder.
    let sec = section(&conn, &s, "S");
    conn.execute(
        "UPDATE sections SET subpath = 'missing' WHERE id = ?1",
        [&sec],
    )
    .expect("subpath");
    let ts = task(&conn, "TS", Some(&s), Some(&sec));
    set_task_folder(
        &conn,
        &SetTaskFolderInput {
            task_id: ts.clone(),
            path: p(&inside),
        },
    )
    .expect("section");
    assert_eq!(
        folder_of(&conn, &ts),
        (Some(p(&inside)), WorkdirSource::Section)
    );
    // Outside the project folder → the task's override.
    set_task_folder(
        &conn,
        &SetTaskFolderInput {
            task_id: ts.clone(),
            path: p(&elsewhere),
        },
    )
    .expect("override");
    assert_eq!(
        folder_of(&conn, &ts),
        (Some(p(&elsewhere)), WorkdirSource::Task)
    );

    // Refused: relative or missing folders.
    assert!(matches!(
        set_task_folder(
            &conn,
            &SetTaskFolderInput {
                task_id: t.clone(),
                path: "rel".into()
            }
        ),
        Err(AppError::Invalid(_))
    ));
    assert!(matches!(
        set_task_folder(
            &conn,
            &SetTaskFolderInput {
                task_id: t,
                path: p(&root.join("nope"))
            }
        ),
        Err(AppError::NotFound(_))
    ));
}
/// A subtask without its own folder shares its parent's, so the folder
/// chosen from it is stored at the parent's level.
#[test]
fn set_task_folder_of_a_subtask_goes_to_its_parent() {
    let conn = open_in_memory().expect("db");
    let dir = tempfile::tempdir().expect("tempdir");
    let p = dir.path().to_string_lossy().into_owned();
    let parent = task(&conn, "Parent", None, None);
    let child = crate::db::subtasks::add(
        &conn,
        &crate::model::AddSubtaskInput {
            task_id: parent.clone(),
            text: "Child".into(),
        },
    )
    .expect("subtask")
    .id;
    set_task_folder(
        &conn,
        &SetTaskFolderInput {
            task_id: child.clone(),
            path: p.clone(),
        },
    )
    .expect("folder");
    assert_eq!(
        tasks::load(&conn, &parent)
            .expect("parent")
            .workdir_override,
        Some(p.clone())
    );
    assert_eq!(
        tasks::load(&conn, &child).expect("child").workdir_override,
        None
    );
    assert_eq!(folder_of(&conn, &child), (Some(p), WorkdirSource::Task));
}

/// Rows from before the state machine: Starting, ended, terminal closed by the user.
#[test]
fn stale_live_sessions_are_settled_at_startup() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    open_claude(&conn, &t, "term-2", "s-2");
    open_claude(&conn, &t, "term-3", "s-3");
    mark_closed_by_user(&conn, "term-1").expect("close");
    mark_exited(&conn, "term-1", None).expect("exit 1");
    mark_exited(&conn, "term-2", Some(1)).expect("exit 2");
    // term-3 is still open: left alone (close_orphans handles it).
    assert_eq!(settle_stale_sessions(&conn).expect("settle"), 2);
    assert_eq!(state_of(&conn, "s-1").0, "paused");
    assert_eq!(state_of(&conn, "s-2").0, "paused");
    assert_eq!(state_of(&conn, "s-3").0, "starting");
    assert_eq!(settle_stale_sessions(&conn).expect("again"), 0);
    // « En pause depuis… » dates from the real stop, not from the repair.
    let (since, ended): (String, String) = conn
        .query_row(
            "SELECT state_changed_at, ended_at FROM agent_sessions WHERE id = 's-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("row");
    assert_eq!(since, ended);
}

#[test]
fn closing_a_crashed_tab_settles_its_session() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    open_claude(&conn, &t, "term-1", "s-1");
    conn.execute("UPDATE agent_sessions SET state = 'crashed'", [])
        .expect("crash");
    assert_eq!(settle_crashed_tab(&conn, "term-1").expect("settle"), 1);
    assert_eq!(state_of(&conn, "s-1").0, "paused");
    assert_eq!(settle_crashed_tab(&conn, "term-1").expect("again"), 0);
}
/// A sub-project without folder works in its parent's (sections on top of
/// it); the folder chosen from one of its tasks becomes the sub-project's own.
#[test]
fn a_project_of_a_group_never_works_in_the_groups_folder() {
    // A group is only visual; its old folder (a former parent's) is ignored.
    let conn = open_in_memory().expect("db");
    let dir = tempfile::tempdir().expect("tempdir");
    let group = subjects::create(
        &conn,
        &crate::model::CreateSubjectInput {
            name: "Globex".into(),
            color: None,
            root_path: None,
            parent_id: None,
        },
    )
    .expect("group")
    .id;
    let sub = sub_project(&conn, &group, "Client", None);
    conn.execute(
        "UPDATE subjects SET root_path = ?2 WHERE id = ?1",
        rusqlite::params![group, dir.path().to_string_lossy()],
    )
    .expect("old folder");
    let t = task(&conn, "T", Some(&sub), None);
    assert!(tasks::detail(&conn, &t).expect("detail").workdir.is_none());
}

#[test]
fn claude_task_of_names_the_task_of_an_open_claude_terminal_only() {
    let conn = open_in_memory().expect("db");
    let s = subject(&conn, "p");
    let t = task(&conn, "T", Some(&s), None);
    open_claude(&conn, &t, "term-1", "s-1");
    insert(
        &conn,
        &NewTerminal {
            id: "shell-1",
            task_id: &t,
            kind: TerminalKind::Shell,
            command: None,
            cwd: "/tmp",
            opened_at: "2026-10-03T10:00:00.000Z",
        },
        None,
    )
    .expect("shell");
    assert_eq!(claude_task_of(&conn, "term-1").expect("q"), Some(t.clone()));
    assert_eq!(claude_task_of(&conn, "shell-1").expect("q"), None);
    assert_eq!(claude_task_of(&conn, "nope").expect("q"), None);
    conn.execute(
        "UPDATE terminals SET closed_at = '2026-10-05T10:00:00.000Z' WHERE id = 'term-1'",
        [],
    )
    .expect("close");
    assert_eq!(claude_task_of(&conn, "term-1").expect("q"), None);
}
