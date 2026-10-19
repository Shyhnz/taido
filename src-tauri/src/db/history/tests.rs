use super::*;
use crate::db::journal::add_for_session;
use crate::db::open_in_memory;
use crate::db::terminals::{insert, mark_closed_by_user, mark_exited, NewSession, NewTerminal};
use crate::db::test_support::task;
use crate::model::{JournalKind, TerminalKind};

fn launch(conn: &Connection, task_id: &str, term: &str, session: &str, at: &str) {
    insert(
        conn,
        &NewTerminal {
            id: term,
            task_id,
            kind: TerminalKind::Agent,
            command: None,
            cwd: "/tmp",
            opened_at: at,
        },
        Some(&NewSession {
            id: session,
            task_id,
            conversation_id: &format!("uuid-{session}"),
            agent: crate::model::Agent::Claude,
            terminal_id: term,
            permission_mode: None,
            add_task_context: true,
            at,
        }),
    )
    .expect("insert");
}

#[test]
fn lists_sessions_newest_first_with_their_first_prompt() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    launch(&conn, &t, "term-1", "s-1", "2026-10-03T09:00:00.000Z");
    launch(&conn, &t, "term-2", "s-2", "2026-10-03T10:00:00.000Z");
    launch(&conn, &t, "term-3", "s-3", "2026-10-03T11:00:00.000Z");
    add_for_session(&conn, &t, "s-1", JournalKind::Prompt, "Premier message").expect("p1");
    add_for_session(&conn, &t, "s-1", JournalKind::TurnEnded, "OK").expect("r1");
    add_for_session(&conn, &t, "s-1", JournalKind::Prompt, "Deuxième").expect("p2");
    add_for_session(&conn, &t, "s-2", JournalKind::Prompt, &"x".repeat(500)).expect("p3");
    // s-1 closed by the user, s-2 died without SessionEnd, s-3 runs in its tab.
    mark_closed_by_user(&conn, "term-1").expect("close");
    mark_exited(&conn, "term-1", None).expect("exit 1");
    mark_exited(&conn, "term-2", Some(9)).expect("exit 2");

    let list = sessions_of_task(&conn, &t, |id| id == "term-3").expect("list");
    let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["s-3", "s-2", "s-1"]);

    let running = &list[0];
    assert_eq!(running.terminal_id.as_deref(), Some("term-3"));
    assert!(!running.resumable, "already in a tab");
    assert!(!running.crashed);
    assert_eq!(running.first_prompt, None);

    let crashed = &list[1];
    assert!(crashed.crashed);
    assert!(crashed.resumable);
    assert_eq!(
        crashed.first_prompt.as_deref().map(|p| p.chars().count()),
        Some(200)
    );

    let closed = &list[2];
    assert!(!closed.crashed);
    assert!(closed.resumable);
    assert_eq!(closed.terminal_id, None);
    assert_eq!(closed.prompt_count, 2);
    assert_eq!(closed.first_prompt.as_deref(), Some("Premier message"));
    assert_eq!(prompt_count(&conn, "s-1").expect("count"), 2);
}
/// A conversation without message is listed only while it runs in a tab
/// (not resumable), and hidden once over (nothing to come back to).
#[test]
fn a_session_without_message_shows_only_while_it_runs() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    launch(&conn, &t, "term-1", "s-1", "2026-10-03T09:00:00.000Z");
    let list = sessions_of_task(&conn, &t, |id| id == "term-1").expect("list");
    assert_eq!(list.len(), 1);
    assert!(!list[0].resumable);
    assert_eq!(list[0].prompt_count, 0);
    assert_eq!(list[0].last_reply, None);
    mark_closed_by_user(&conn, "term-1").expect("close");
    mark_exited(&conn, "term-1", None).expect("exit");
    assert!(sessions_of_task(&conn, &t, |_| false)
        .expect("list")
        .is_empty());
}

/// The recap: the first sentence of the last reply, 160 characters at most.
#[test]
fn last_reply_is_the_first_sentence_of_the_last_turn() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    launch(&conn, &t, "term-1", "s-1", "2026-10-03T09:00:00.000Z");
    launch(&conn, &t, "term-2", "s-2", "2026-10-03T10:00:00.000Z");
    let add = |session: &str, kind: JournalKind, text: &str| {
        add_for_session(&conn, &t, session, kind, text).expect("add");
    };
    add("s-1", JournalKind::Prompt, "Corrige le bug");
    add("s-1", JournalKind::TurnEnded, "Je regarde. Une minute.");
    add("s-1", JournalKind::Prompt, "Alors ?");
    add(
        "s-1",
        JournalKind::TurnEnded,
        "```\ncode\n```\n**C'est corrigé** dans `main.rs`. Les tests passent.",
    );
    add("s-1", JournalKind::Error, "rate_limit");
    add("s-2", JournalKind::Prompt, "Long");
    add("s-2", JournalKind::TurnEnded, &"mot ".repeat(100));
    let list = sessions_of_task(&conn, &t, |_| false).expect("list");
    let by_id = |id: &str| {
        list.iter()
            .find(|s| s.id == id)
            .and_then(|s| s.last_reply.clone())
    };
    assert_eq!(by_id("s-1").as_deref(), Some("C'est corrigé dans main.rs."));
    let long = by_id("s-2").expect("reply");
    assert_eq!(long.chars().count(), 160);
    assert!(long.ends_with('…'));
}

#[test]
fn exchanges_are_the_trace_oldest_first() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    launch(&conn, &t, "term-1", "s-1", "2026-10-03T09:00:00.000Z");
    for (kind, text) in [
        (JournalKind::Prompt, "Bonjour"),
        (JournalKind::TurnEnded, "Salut"),
        (JournalKind::Error, "rate_limit"),
        (JournalKind::Compacted, ""),
        (JournalKind::Cleared, ""),
    ] {
        add_for_session(&conn, &t, "s-1", kind, text).expect("add");
    }
    // A task-level entry is not part of the session trace.
    crate::db::journal::add(&conn, &t, JournalKind::Completed, "").expect("task entry");
    let kinds: Vec<ExchangeKind> = exchanges(&conn, "s-1")
        .expect("exchanges")
        .into_iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        kinds,
        [
            ExchangeKind::Prompt,
            ExchangeKind::Reply,
            ExchangeKind::Error,
            ExchangeKind::Compacted,
            ExchangeKind::Cleared
        ]
    );
}

/// Migration 0004: early sessions get their trace back from the raw hook
/// events (prompts and replies of their own conversation only).
#[test]
fn backfill_rebuilds_the_trace_from_hook_events() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    launch(&conn, &t, "term-1", "s-1", "2026-10-03T09:00:00.000Z");
    let log = |event: &str, payload: &str| {
        crate::db::terminals::log_hook_event(&conn, Some("term-1"), event, payload)
            .expect("hook event");
    };
    log(
        "UserPromptSubmit",
        r#"{"session_id":"uuid-s-1","hook_event_name":"UserPromptSubmit","prompt":"Bonjour"}"#,
    );
    log(
        "Stop",
        r#"{"session_id":"uuid-s-1","hook_event_name":"Stop","last_assistant_message":"Salut"}"#,
    );
    log(
        "UserPromptSubmit",
        r#"{"session_id":"someone-else","hook_event_name":"UserPromptSubmit","prompt":"Non"}"#,
    );
    log("Stop", "not json");
    // Replayed on today's schema, where migration 0019 renamed the column it joins on.
    conn.execute_batch(
        &include_str!("../../../migrations/0004_session_trace_backfill.sql")
            .replace("claude_session_id", "conversation_id"),
    )
    .expect("backfill");
    let texts: Vec<String> = exchanges(&conn, "s-1")
        .expect("trace")
        .into_iter()
        .map(|e| e.text)
        .collect();
    assert_eq!(texts, ["Bonjour", "Salut"]);
    // Running it again adds nothing (the session already has a trace).
    conn.execute_batch(
        &include_str!("../../../migrations/0004_session_trace_backfill.sql")
            .replace("claude_session_id", "conversation_id"),
    )
    .expect("again");
    assert_eq!(exchanges(&conn, "s-1").expect("trace").len(), 2);
}

#[test]
fn each_summary_names_its_agent() {
    let conn = open_in_memory().expect("db");
    let t = task(&conn, "T", None, None);
    launch(&conn, &t, "term-1", "s-1", "2026-10-03T09:00:00.000Z");
    crate::db::test_support::codex_terminal(&conn, &t, "term-2", "s-2", "pending:x");
    let list = sessions_of_task(&conn, &t, |_| true).expect("list");
    let agent = |id: &str| list.iter().find(|s| s.id == id).map(|s| s.agent);
    assert_eq!(agent("s-1"), Some(crate::model::Agent::Claude));
    assert_eq!(agent("s-2"), Some(crate::model::Agent::Codex));
}
