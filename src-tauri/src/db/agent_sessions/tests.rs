use super::*;
use crate::db::open_in_memory;
use crate::db::terminals::{mark_closed_by_user, mark_exited};
use crate::db::test_support::{claude_terminal, codex_terminal, task};
use crate::model::Agent;

const AT: &str = "2026-10-03T10:05:00.000Z";

#[test]
fn state_columns_round_trip() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "Export", None, None);
    claude_terminal(&conn, &t, "term", "sess", "uuid-1");
    let row = by_terminal(&conn, "term").expect("query").expect("row");
    assert_eq!(row.id, "sess");
    assert_eq!(row.task_id, t);
    assert_eq!(row.session.state, SessionState::Starting);
    assert_eq!(row.session.conversation_id, "uuid-1");
    assert_eq!(by_terminal(&conn, "other").expect("query"), None);

    let s = Session {
        state: SessionState::Waiting,
        waiting_kind: Some(WaitingKind::Permission),
        activity: Some("Commande : ls".into()),
        last_message: Some("OK".into()),
        question: Some("On pousse ?".into()),
        pending_permission: Some(PendingPermission {
            tool_name: "Bash".into(),
            summary: "Commande : rm -rf dist".into(),
            tool_input: serde_json::json!({ "command": "rm -rf dist" }),
        }),
        error_kind: None,
        ended_cleanly: true,
        state_changed_at: AT.into(),
        ..row.session.clone()
    };
    save(&conn, "sess", &s, AT).expect("save");
    let back = get(&conn, "sess").expect("get");
    assert_eq!(back.session, s);
    let pending: String = conn
        .query_row(
            "SELECT pending_permission FROM agent_sessions WHERE id = 'sess'",
            [],
            |r| r.get(0),
        )
        .expect("pending");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&pending).expect("json")["tool_name"],
        "Bash"
    );
    assert!(matches!(get(&conn, "nope"), Err(AppError::NotFound(_))));
}

#[test]
fn facts_know_whether_the_terminal_is_open() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "Export", None, None);
    claude_terminal(&conn, &t, "a", "sa", "uuid-a");
    claude_terminal(&conn, &t, "b", "sb", "uuid-b");
    mark_exited(&conn, "b", Some(0)).expect("exit");
    let mut facts = facts_for_task(&conn, &t).expect("facts");
    facts.sort_by_key(|x| x.terminal_open);
    assert_eq!(facts.len(), 2);
    assert!(!facts[0].terminal_open);
    assert!(facts[1].terminal_open);
    assert!(facts_for_task(&conn, "other").expect("facts").is_empty());
}

#[test]
fn views_show_each_field_in_its_state_only() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "Export", None, None);
    claude_terminal(&conn, &t, "term", "sess", "uuid-1");
    let base = get(&conn, "sess").expect("get").session;
    let pending = Some(PendingPermission {
        tool_name: "Bash".into(),
        summary: "Commande : rm -rf dist".into(),
        tool_input: serde_json::Value::Null,
    });
    let full = Session {
        activity: Some("Lecture a.rs".into()),
        last_message: Some("Fini.\n\nOn pousse ?".into()),
        // Stored at `Stop`, not found again from `last_message` (cut at 500 characters).
        question: Some("On pousse vraiment ?".into()),
        pending_permission: pending,
        state_changed_at: AT.into(),
        ..base
    };
    let view_in = |state, kind, error: Option<&str>| {
        let s = Session {
            state,
            waiting_kind: kind,
            error_kind: error.map(String::from),
            ..full.clone()
        };
        save(&conn, "sess", &s, AT).expect("save");
        views(&conn, &["sess".to_string()])
            .expect("views")
            .pop()
            .expect("view")
    };

    let v = view_in(SessionState::Working, None, None);
    assert_eq!(v.terminal_id.as_deref(), Some("term"));
    assert_eq!(v.activity.as_deref(), Some("Lecture a.rs"));
    assert_eq!(
        (v.question, v.permission, v.last_message),
        (None, None, None)
    );
    assert_eq!(v.since, AT);

    let v = view_in(SessionState::Waiting, Some(WaitingKind::Permission), None);
    assert_eq!(v.waiting_kind, Some(WaitingKind::Permission));
    assert_eq!(v.permission.as_deref(), Some("Commande : rm -rf dist"));
    assert_eq!((v.activity, v.question), (None, None));
    assert_eq!(v.permissions_more, 0);

    let v = view_in(SessionState::Waiting, Some(WaitingKind::Question), None);
    assert_eq!(v.question.as_deref(), Some("On pousse vraiment ?"));
    assert_eq!(v.permission, None);

    let v = view_in(SessionState::Done, None, None);
    assert_eq!(v.last_message.as_deref(), Some("Fini.\n\nOn pousse ?"));
    assert_eq!(v.waiting_kind, None);

    let v = view_in(SessionState::Error, None, Some("rate_limit"));
    assert_eq!(v.error_kind.as_deref(), Some("rate_limit"));
    assert_eq!(v.last_message, None);

    // Once its terminal is closed, the session has no current terminal any more.
    mark_closed_by_user(&conn, "term").expect("close");
    let v = view_in(SessionState::Paused, None, None);
    assert_eq!(v.terminal_id, None);
    assert_eq!(v.state, SessionState::Paused);

    let none = views(&conn, &["missing".to_string()]).expect("views");
    assert!(none.is_empty());
}

/// Review #4: a resume whose process cannot start gives the session back
/// exactly what it had (a clean session must not read as crashed).
#[test]
fn a_failed_resume_restores_the_session() {
    let conn = crate::db::open_in_memory().expect("db");
    let t = crate::db::test_support::task(&conn, "T", None, None);
    crate::db::test_support::claude_terminal(&conn, &t, "term-1", "s-1", "uuid-1");
    crate::db::terminals::mark_closed_by_user(&conn, "term-1").expect("close");
    crate::db::terminals::mark_exited(&conn, "term-1", Some(0)).expect("exit");
    conn.execute(
        "UPDATE agent_sessions SET state = 'paused', ended_cleanly = 1",
        [],
    )
    .expect("history");
    let read = |c: &Connection| -> (Option<String>, String, bool, Option<String>) {
        c.query_row(
            "SELECT current_terminal_id, state, ended_cleanly, ended_at FROM agent_sessions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("row")
    };
    let original = read(&conn);
    crate::db::terminals::insert(
        &conn,
        &crate::db::terminals::NewTerminal {
            id: "term-2",
            task_id: &t,
            kind: crate::model::TerminalKind::Agent,
            command: None,
            cwd: "/tmp",
            opened_at: "2026-10-03T12:00:00.000Z",
        },
        None,
    )
    .expect("terminal");
    let before =
        attach_resumed(&conn, "s-1", "term-2", &t, "2026-10-03T12:00:00.000Z").expect("attach");
    assert_eq!(read(&conn).0.as_deref(), Some("term-2"));
    detach_failed_resume(&conn, "term-2", &before).expect("detach");
    assert_eq!(read(&conn), original);
    assert!(!crate::db::terminals::is_open(&conn, "term-2").expect("gone"));
}

#[test]
fn claude_sessions_keep_their_agent_and_conversation() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "Export", None, None);
    claude_terminal(&conn, &t, "term", "sess", "abc");
    let row = get(&conn, "sess").expect("get");
    assert_eq!(row.agent, Agent::Claude);
    assert_eq!(row.session.conversation_id, "abc");
    // Rows written before the migration read as Claude (column default).
    let agent: String = conn
        .query_row(
            "SELECT agent FROM agent_sessions WHERE id = 'sess'",
            [],
            |r| r.get(0),
        )
        .expect("agent");
    assert_eq!(agent, "claude");
}

#[test]
fn a_pending_codex_conversation_is_adopted() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "Export", None, None);
    codex_terminal(&conn, &t, "term", "sess", "pending:1234");
    let row = get(&conn, "sess").expect("get");
    assert_eq!(row.agent, Agent::Codex);
    assert!(is_pending_conversation(&row.session.conversation_id));
    adopt_conversation(&conn, "sess", "019a-real").expect("adopt");
    let row = get(&conn, "sess").expect("get");
    assert_eq!(row.session.conversation_id, "019a-real");
    assert!(!is_pending_conversation("019a-real"));
}

#[test]
fn the_view_names_its_agent() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "Export", None, None);
    codex_terminal(&conn, &t, "term", "sess", "pending:1");
    let views = views(&conn, &["sess".to_string()]).expect("views");
    assert_eq!(views[0].agent, Agent::Codex);
}
