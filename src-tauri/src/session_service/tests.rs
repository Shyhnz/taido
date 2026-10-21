//! Routing tests: real fixture payloads POSTed to a bound `HookServer` whose recorder is the
//! service, against an in-memory database with a Claude terminal and its session.

use std::time::Instant;

use serde_json::Value;

use super::*;
use crate::db::test_support::{claude_terminal, set_session_state, subject, task};
use crate::db::{open_in_memory, terminals};
use crate::hooks::{test_fixture, test_post, test_serve, HookServer, Recorder};
use crate::model::{LineKind, Ring, TerminalKind};

const SID: &str = "11111111-2222-4333-8444-555555555555";
const TERM: &str = "term-1";
const SESSION: &str = "sess-1";

struct Fixture {
    db: Arc<Mutex<Connection>>,
    service: Arc<SessionService>,
    flushes: Arc<Mutex<Vec<Flush>>>,
    task_id: String,
    subject_id: String,
}

fn fixture(timing: Timing) -> Fixture {
    let conn = open_in_memory().expect("db");
    let subject_id = subject(&conn, "Globex");
    let task_id = task(&conn, "Export CSV", Some(&subject_id), None);
    claude_terminal(&conn, &task_id, TERM, SESSION, SID);
    let db = Arc::new(Mutex::new(conn));
    let flushes: Arc<Mutex<Vec<Flush>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&flushes);
    let sink: FlushSink = Arc::new(move |flush| seen.lock().expect("lock").push(flush));
    let service = Arc::new(SessionService::new(Arc::clone(&db), sink, timing));
    Fixture {
        db,
        service,
        flushes,
        task_id,
        subject_id,
    }
}

fn slow_timers() -> Timing {
    Timing {
        starting_timeout: Duration::from_secs(600),
        batch_window: Duration::from_millis(20),
    }
}

/// (state, waiting_kind, activity, last_message, pending summary, error_kind, ended_cleanly)
type Columns = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

impl Fixture {
    fn columns(&self) -> Columns {
        let conn = self.db.lock().expect("lock");
        let row = agent_sessions::get(&conn, SESSION).expect("session");
        let s = row.session;
        (
            s.state.as_str().to_string(),
            s.waiting_kind.map(|k| k.as_str().to_string()),
            s.activity,
            s.last_message,
            s.pending_permission.map(|p| p.summary),
            s.error_kind,
            s.ended_cleanly,
        )
    }

    fn state(&self) -> (String, Option<String>) {
        let c = self.columns();
        (c.0, c.1)
    }

    fn set_state(&self, state: &str, kind: Option<&str>) {
        let conn = self.db.lock().expect("lock");
        set_session_state(&conn, SESSION, state, kind, "2026-10-03T10:00:00.000Z");
    }

    /// Starts a hook server whose recorder is the service; returns its port and token.
    fn serve(&self) -> (u16, String) {
        let server = HookServer::bind().expect("bind");
        let (port, token) = (server.port, server.token.clone());
        let service = Arc::clone(&self.service);
        let recorder: Recorder = Arc::new(move |terminal, event, payload| {
            service.on_hook(terminal, event, payload);
        });
        test_serve(server, recorder);
        (port, token)
    }

    fn hook_count(&self) -> i64 {
        let conn = self.db.lock().expect("lock");
        conn.query_row("SELECT COUNT(*) FROM hook_events", [], |r| r.get(0))
            .expect("count")
    }

    fn info(&self, exit_code: Option<i32>) -> TerminalInfo {
        TerminalInfo {
            id: TERM.into(),
            task_id: self.task_id.clone(),
            kind: TerminalKind::Agent,
            command: None,
            cwd: "/tmp".into(),
            opened_at: "2026-10-03T10:00:00.000Z".into(),
            running: exit_code.is_none(),
            exit_code,
            agent_session_id: Some(SESSION.into()),
            agent: Some(crate::model::Agent::Claude),
        }
    }
}

/// A real payload rewritten for the session's conversation.
fn payload(file: &str, session_id: &str) -> String {
    let mut json: Value = serde_json::from_str(&test_fixture(file)).expect("json");
    json["session_id"] = Value::String(session_id.into());
    json.to_string()
}

/// The real `PostToolUse` payload, for the command of the real `PermissionRequest` (the two
/// fixtures come from different runs).
fn answered_post(session_id: &str) -> String {
    let mut json: Value =
        serde_json::from_str(&payload("PostToolUse-Bash.json", session_id)).expect("json");
    let request: Value =
        serde_json::from_str(&test_fixture("PermissionRequest-Bash.json")).expect("json");
    json["tool_input"] = request["tool_input"].clone();
    json.to_string()
}

fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn s(v: &str) -> Option<String> {
    Some(v.to_string())
}

#[test]
fn routes_a_permission_turn_posted_with_real_payloads() {
    let f = fixture(slow_timers());
    let (port, token) = f.serve();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    let post = |what: &str, payload: &str| {
        let (status, body) = test_post(port, &headers, payload);
        assert!(status.contains("200"), "{what}: {status}");
        assert_eq!(body, "{}", "{what}: answered at once");
    };
    let send = |file: &str| post(file, &payload(file, SID));

    send("SessionStart-startup.json");
    assert_eq!(f.state(), ("idle".into(), None));
    send("UserPromptSubmit.json");
    assert_eq!(f.state(), ("working".into(), None));
    send("PreToolUse-Bash.json");
    assert_eq!(f.columns().2, s("Commande : echo spike1 > /dev/null"));
    send("PermissionRequest-Bash.json");
    let c = f.columns();
    assert_eq!(
        (c.0.as_str(), c.1.as_deref()),
        ("waiting", Some("permission"))
    );
    assert_eq!(c.4, s("Commande : touch spike-1.txt"));
    send("Notification-permission_prompt.json");
    assert_eq!(f.state(), ("waiting".into(), s("permission")));
    // Another tool (`echo`, a parallel sub-agent) ran: the request stays pending (8.5 point 6).
    send("PostToolUse-Bash.json");
    let c = f.columns();
    assert_eq!(
        (c.0.as_str(), c.4.as_deref()),
        ("waiting", Some("Commande : touch spike-1.txt"))
    );
    // The requested command ran: the user answered in the terminal.
    post("PostToolUse of the request", &answered_post(SID));
    let c = f.columns();
    assert_eq!((c.0.as_str(), c.4), ("working", None));
    send("Stop-question.json");
    let c = f.columns();
    assert_eq!(
        (c.0.as_str(), c.1.as_deref()),
        ("waiting", Some("question"))
    );
    assert_eq!(c.3, s("Tu veux un café ?"));
    send("UserPromptSubmit.json");
    send("Stop.json");
    assert_eq!(f.columns().3, s("OK"));
    assert_eq!(f.state(), ("done".into(), None));
    send("Notification-idle_prompt.json");
    send("MessageDisplay.json");
    assert_eq!(f.state(), ("done".into(), None), "ignored events");
    send("SessionStart-compact.json");
    assert_eq!(f.state(), ("done".into(), None));
    send("SessionEnd-prompt_input_exit.json");
    let c = f.columns();
    assert_eq!(c.0, "done");
    assert!(c.6, "ended cleanly");
    assert_eq!(f.hook_count(), 14, "every event is logged");

    // The exit after SessionEnd pauses the session.
    assert!(!f.service.exited(&f.info(Some(0))).expect("exit"));
    assert_eq!(f.state(), ("paused".into(), None));
}

#[test]
fn stop_failure_and_elicitation() {
    let f = fixture(slow_timers());
    let (port, token) = f.serve();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    let body =
        format!(r#"{{"hook_event_name":"StopFailure","session_id":"{SID}","error":"rate_limit"}}"#);
    test_post(port, &headers, &body);
    let c = f.columns();
    assert_eq!((c.0.as_str(), c.5), ("error", s("rate_limit")));
    let body = format!(
        r#"{{"hook_event_name":"Notification","session_id":"{SID}",
            "notification_type":"elicitation_dialog"}}"#
    );
    test_post(port, &headers, &body);
    let c = f.columns();
    assert_eq!((c.0.as_str(), c.1, c.5), ("waiting", s("input"), None));
}

#[test]
fn other_conversations_and_unknown_terminals_are_only_logged() {
    let f = fixture(slow_timers());
    let (port, token) = f.serve();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    // A late event of another conversation (the fixture's own session id) is ignored.
    test_post(port, &headers, &test_fixture("UserPromptSubmit.json"));
    assert_eq!(f.state(), ("starting".into(), None));
    // No terminal header, or a terminal without session.
    test_post(
        port,
        &[("X-App-Token", token.as_str())],
        &payload("UserPromptSubmit.json", SID),
    );
    test_post(
        port,
        &[
            ("X-App-Token", token.as_str()),
            ("X-Terminal-Id", "shell-9"),
        ],
        &payload("UserPromptSubmit.json", SID),
    );
    assert_eq!(f.state(), ("starting".into(), None));
    assert_eq!(f.hook_count(), 3);
    // A payload without `session_id` is routed (tolerant decoding).
    test_post(port, &headers, r#"{"hook_event_name":"UserPromptSubmit"}"#);
    assert_eq!(f.state(), ("working".into(), None));
}

#[test]
fn changes_are_batched_per_task() {
    let f = fixture(Timing {
        starting_timeout: Duration::from_secs(600),
        batch_window: Duration::from_millis(300),
    });
    for file in [
        "SessionStart-startup.json",
        "UserPromptSubmit.json",
        "PreToolUse-Bash.json",
        "PostToolUse-Bash.json",
        "PreToolUse-Bash.json",
        "PermissionRequest-Bash.json",
    ] {
        let name = file.split(['-', '.']).next().expect("name");
        f.service.on_hook(Some(TERM), name, &payload(file, SID));
    }
    eventually("a batch", || !f.flushes.lock().expect("lock").is_empty());
    std::thread::sleep(Duration::from_millis(400));
    let flushes = f.flushes.lock().expect("lock");
    assert_eq!(flushes.len(), 1, "one batch for the burst");
    let flush = &flushes[0];
    assert_eq!(flush.changes.len(), 1, "one change per task");
    let change = &flush.changes[0];
    assert_eq!(change.task_id, f.task_id);
    assert_eq!(change.subject_id.as_deref(), Some(f.subject_id.as_str()));
    assert_eq!(change.ring, Ring::Waiting);
    let line = change.line.as_ref().expect("line");
    assert_eq!(line.kind, LineKind::WaitingPermission);
    assert_eq!(line.text.as_deref(), Some("Commande : touch spike-1.txt"));
    let counts = flush.counts.expect("counts");
    assert_eq!(counts.waiting, 1);
}

#[test]
fn starting_timeout_moves_to_waiting_input() {
    let f = fixture(Timing {
        starting_timeout: Duration::from_millis(50),
        batch_window: Duration::from_millis(10),
    });
    f.service.launched(&f.info(None));
    eventually("waiting input", || {
        f.state() == ("waiting".into(), Some("input".into()))
    });
    let change = {
        eventually("batch", || {
            f.flushes
                .lock()
                .expect("lock")
                .iter()
                .any(|fl| fl.changes.iter().any(|c| c.ring == Ring::Waiting))
        });
        let flushes = f.flushes.lock().expect("lock");
        flushes
            .iter()
            .flat_map(|fl| fl.changes.clone())
            .last()
            .expect("change")
    };
    assert_eq!(change.line.map(|l| l.kind), Some(LineKind::WaitingInput));
    // A SessionStart afterwards makes it Idle.
    f.service.on_hook(
        Some(TERM),
        "SessionStart",
        &payload("SessionStart-startup.json", SID),
    );
    assert_eq!(f.state(), ("idle".into(), None));
}

#[test]
fn starting_timeout_does_nothing_after_session_start() {
    let f = fixture(Timing {
        starting_timeout: Duration::from_millis(100),
        batch_window: Duration::from_millis(10),
    });
    f.service.launched(&f.info(None));
    f.service.on_hook(
        Some(TERM),
        "SessionStart",
        &payload("SessionStart-startup.json", SID),
    );
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(f.state(), ("idle".into(), None));
}

#[test]
fn escape_interrupts_only_working_or_permission() {
    let f = fixture(slow_timers());
    /// State and waiting kind, as stored.
    type Stored = (&'static str, Option<&'static str>);
    let cases: &[(&str, Option<&str>, &str, Stored)] = &[
        ("working", None, ESCAPE, ("idle", None)),
        ("waiting", Some("permission"), ESCAPE, ("idle", None)),
        ("working", None, "a", ("working", None)),
        ("working", None, "\x1b[A", ("working", None)),
        ("done", None, ESCAPE, ("done", None)),
        (
            "waiting",
            Some("question"),
            ESCAPE,
            ("waiting", Some("question")),
        ),
        ("idle", None, ESCAPE, ("idle", None)),
    ];
    for &(state, kind, data, (to_state, to_kind)) in cases {
        f.set_state(state, kind);
        f.service.typed(TERM, data).expect("typed");
        assert_eq!(
            f.state(),
            (to_state.to_string(), to_kind.map(String::from)),
            "{state} {kind:?} + {data:?}"
        );
    }
    // Not a Claude terminal: nothing.
    f.service.typed("shell-1", ESCAPE).expect("typed");
}

#[test]
fn interrupt_goes_idle_and_empties_the_queue() {
    let f = fixture(slow_timers());
    f.service.on_hook(
        Some(TERM),
        "PermissionRequest",
        &payload("PermissionRequest-Bash.json", SID),
    );
    assert_eq!(f.columns().4, s("Commande : touch spike-1.txt"));
    assert_eq!(f.service.terminal_of(SESSION).expect("terminal"), TERM);
    f.service.interrupt(SESSION).expect("interrupt");
    let c = f.columns();
    assert_eq!((c.0.as_str(), c.4), ("idle", None));
    assert!(matches!(
        f.service.interrupt("missing"),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn process_exit_pauses_or_crashes() {
    // Without SessionEnd: Crashed.
    let f = fixture(slow_timers());
    f.set_state("working", None);
    assert!(!f.service.exited(&f.info(Some(1))).expect("exit"));
    assert_eq!(f.state(), ("crashed".into(), None));
    {
        let conn = f.db.lock().expect("lock");
        let (closed, code): (Option<String>, Option<i32>) = conn
            .query_row(
                "SELECT closed_at, exit_code FROM terminals WHERE id = ?1",
                [TERM],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("terminal");
        assert!(closed.is_some());
        assert_eq!(code, Some(1));
    }

    // Closed by the user: Paused, even without SessionEnd.
    let f = fixture(slow_timers());
    f.set_state("waiting", Some("permission"));
    {
        let conn = f.db.lock().expect("lock");
        terminals::mark_closed_by_user(&conn, TERM).expect("close");
    }
    assert!(f.service.exited(&f.info(None)).expect("exit"));
    assert_eq!(f.state(), ("paused".into(), None));

    // Exit code 0 before its SessionEnd arrived (a slow hook relay): Paused.
    let f = fixture(slow_timers());
    f.set_state("idle", None);
    assert!(!f.service.exited(&f.info(Some(0))).expect("exit"));
    assert_eq!(f.state(), ("paused".into(), None));
}

#[test]
fn launch_marks_the_task_starting() {
    let f = fixture(Timing {
        starting_timeout: Duration::from_secs(600),
        batch_window: Duration::from_millis(10),
    });
    f.service.launched(&f.info(None));
    eventually("batch", || !f.flushes.lock().expect("lock").is_empty());
    let flushes = f.flushes.lock().expect("lock");
    let change = &flushes[0].changes[0];
    assert_eq!(change.ring, Ring::Starting);
    assert_eq!(
        change.line.as_ref().map(|l| l.kind),
        Some(LineKind::Starting)
    );
}

fn session_row(f: &Fixture, id: &str) -> agent_sessions::SessionRow {
    agent_sessions::get(&f.db.lock().expect("lock"), id).expect("session")
}

fn trace(f: &Fixture, id: &str) -> Vec<(crate::model::ExchangeKind, String)> {
    crate::db::history::exchanges(&f.db.lock().expect("lock"), id)
        .expect("exchanges")
        .into_iter()
        .map(|e| (e.kind, e.text))
        .collect()
}

#[test]
fn prompts_replies_and_errors_go_to_the_session_trace() {
    use crate::model::ExchangeKind::*;
    let f = fixture(slow_timers());
    let (port, token) = f.serve();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    test_post(port, &headers, &payload("SessionStart-startup.json", SID));
    let mut prompt: Value =
        serde_json::from_str(&payload("UserPromptSubmit.json", SID)).expect("json");
    prompt["prompt"] = Value::String("Sur quelle tâche je suis ?".into());
    test_post(port, &headers, &prompt.to_string());
    let mut stop: Value = serde_json::from_str(&payload("Stop.json", SID)).expect("json");
    stop["last_assistant_message"] = Value::String("Export CSV, projet Globex.".into());
    test_post(port, &headers, &stop.to_string());
    test_post(
        port,
        &headers,
        &format!(
            r#"{{"hook_event_name":"StopFailure","session_id":"{SID}","error":"rate_limit"}}"#
        ),
    );
    assert_eq!(
        trace(&f, SESSION),
        [
            (Prompt, "Sur quelle tâche je suis ?".to_string()),
            (Reply, "Export CSV, projet Globex.".to_string()),
            (Error, "rate_limit".to_string()),
        ]
    );
}

#[test]
fn clear_moves_the_terminal_to_a_new_conversation() {
    const NEW: &str = "99999999-2222-4333-8444-555555555555";
    let f = fixture(slow_timers());
    let reattached: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&reattached);
    f.service.set_reattach_hook(Arc::new(move |t, s| {
        seen.lock()
            .expect("lock")
            .push((t.to_string(), s.to_string()));
    }));
    let (port, token) = f.serve();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    test_post(port, &headers, &payload("SessionStart-startup.json", SID));
    test_post(port, &headers, &payload("UserPromptSubmit.json", SID));
    // `/clear`: SessionEnd(clear) of the old conversation, then SessionStart(clear) of a new one.
    test_post(port, &headers, &payload("SessionEnd-clear.json", SID));
    test_post(port, &headers, &payload("SessionStart-clear.json", NEW));

    let old = session_row(&f, SESSION);
    assert_eq!(old.session.state, SessionState::Paused);
    assert_eq!(old.current_terminal_id, None);
    assert!(trace(&f, SESSION)
        .iter()
        .any(|(k, _)| *k == crate::model::ExchangeKind::Cleared));

    let new = agent_sessions::by_terminal(&f.db.lock().expect("lock"), TERM)
        .expect("query")
        .expect("new session on the terminal");
    assert_eq!(new.session.conversation_id, NEW);
    assert_eq!(new.session.state, SessionState::Idle);
    assert_eq!(new.task_id, f.task_id);
    assert_eq!(
        reattached.lock().expect("lock").as_slice(),
        [(TERM.to_string(), new.id.clone())]
    );
    // The new conversation's events now drive the ring.
    test_post(port, &headers, &payload("UserPromptSubmit.json", NEW));
    assert_eq!(
        session_row(&f, &new.id).session.state,
        SessionState::Working
    );
    assert_eq!(session_row(&f, SESSION).session.state, SessionState::Paused);
}

#[test]
fn resume_typed_in_claude_reattaches_a_known_conversation() {
    const KNOWN: &str = "77777777-2222-4333-8444-555555555555";
    let f = fixture(slow_timers());
    {
        let conn = f.db.lock().expect("lock");
        crate::db::test_support::claude_terminal(&conn, &f.task_id, "term-old", "sess-old", KNOWN);
        terminals::mark_exited(&conn, "term-old", Some(0)).expect("exit");
        conn.execute(
            "UPDATE agent_sessions SET state = 'paused' WHERE id = 'sess-old'",
            [],
        )
        .expect("history");
    }
    let (port, token) = f.serve();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    test_post(port, &headers, &payload("SessionStart-startup.json", SID));
    test_post(port, &headers, &payload("SessionStart-resume.json", KNOWN));
    let back = session_row(&f, "sess-old");
    assert_eq!(back.current_terminal_id.as_deref(), Some(TERM));
    assert_eq!(back.session.state, SessionState::Idle);
    assert!(trace(&f, "sess-old")
        .iter()
        .any(|(k, _)| *k == crate::model::ExchangeKind::Resumed));
    assert_eq!(session_row(&f, SESSION).current_terminal_id, None);
}

/// Review #5: a trace entry refreshes the task even when the state does not
/// change (a compaction while Idle).
#[test]
fn a_trace_entry_alone_refreshes_the_task() {
    let f = fixture(slow_timers());
    let (port, token) = f.serve();
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    test_post(port, &headers, &payload("SessionStart-startup.json", SID));
    eventually("Idle emitted", || {
        !f.flushes.lock().expect("lock").is_empty()
    });
    let before = f.flushes.lock().expect("lock").len();
    test_post(port, &headers, &payload("SessionStart-compact.json", SID));
    eventually("a batch for the compaction", || {
        f.flushes.lock().expect("lock").len() > before
    });
    assert_eq!(f.state(), ("idle".into(), None));
}
/// A subtask's session change also reaches its parent's row, whose ring
/// sums up its children's sessions.
#[test]
fn a_subtask_change_is_also_its_parents() {
    let f = fixture(Timing {
        starting_timeout: Duration::from_secs(600),
        batch_window: Duration::from_millis(20),
    });
    const CHILD_SID: &str = "99999999-2222-4333-8444-555555555555";
    let child_id = {
        let conn = f.db.lock().expect("lock");
        let child = crate::db::subtasks::add(
            &conn,
            &crate::model::AddSubtaskInput {
                task_id: f.task_id.clone(),
                text: "Sous-tâche".into(),
            },
        )
        .expect("subtask")
        .id;
        claude_terminal(&conn, &child, "term-child", "sess-child", CHILD_SID);
        child
    };
    f.service.on_hook(
        Some("term-child"),
        "PermissionRequest",
        &payload("PermissionRequest-Bash.json", CHILD_SID),
    );
    eventually("a batch", || !f.flushes.lock().expect("lock").is_empty());
    let flushes = f.flushes.lock().expect("lock");
    let changes: Vec<(String, Ring)> = flushes
        .iter()
        .flat_map(|fl| fl.changes.iter())
        .map(|c| (c.task_id.clone(), c.ring))
        .collect();
    assert!(
        changes.contains(&(child_id.clone(), Ring::Waiting)),
        "{changes:?}"
    );
    assert!(
        changes.contains(&(f.task_id.clone(), Ring::Waiting)),
        "the parent's ring: {changes:?}"
    );
    let change = flushes
        .iter()
        .flat_map(|fl| fl.changes.iter())
        .find(|c| c.task_id == f.task_id)
        .expect("parent change");
    assert_eq!(
        change.line.as_ref().map(|l| l.kind),
        Some(LineKind::WaitingPermission)
    );
    let counts = flushes.last().and_then(|fl| fl.counts).expect("counts");
    assert_eq!(counts.waiting, 1, "the parent counts once");
}

/// Notices of all the batches so far.
fn notices(f: &Fixture) -> Vec<Notice> {
    f.flushes
        .lock()
        .expect("lock")
        .iter()
        .flat_map(|fl| fl.notices.clone())
        .collect()
}

#[test]
fn a_finished_turn_notifies_with_the_session_terminal() {
    let f = fixture(slow_timers());
    for file in [
        "SessionStart-startup.json",
        "UserPromptSubmit.json",
        "PreToolUse-Bash.json",
    ] {
        let name = file.split(['-', '.']).next().expect("name");
        f.service.on_hook(Some(TERM), name, &payload(file, SID));
    }
    eventually("working", || f.state() == ("working".into(), None));
    eventually("a batch", || !f.flushes.lock().expect("lock").is_empty());
    assert!(notices(&f).is_empty(), "working does not notify");

    f.service
        .on_hook(Some(TERM), "Stop", &payload("Stop.json", SID));
    eventually("a notice", || !notices(&f).is_empty());
    assert_eq!(
        notices(&f),
        [Notice {
            task_id: f.task_id.clone(),
            terminal_id: Some(TERM.into()),
            title: "Globex · Export CSV".into(),
            body: "Claude a fini".into(),
        }]
    );
}

#[test]
fn a_permission_request_notifies_that_claude_waits() {
    let f = fixture(slow_timers());
    f.set_state("working", None);
    f.service.on_hook(
        Some(TERM),
        "PermissionRequest",
        &payload("PermissionRequest-Bash.json", SID),
    );
    eventually("a notice", || !notices(&f).is_empty());
    let notice = notices(&f).pop().expect("notice");
    assert_eq!(notice.body, "Claude attend ta réponse");
}

#[test]
fn no_notice_when_the_setting_is_off() {
    let f = fixture(slow_timers());
    {
        let conn = f.db.lock().expect("lock");
        settings::update(
            &conn,
            &crate::model::SettingsPatch {
                notifications: Some(false),
                ..Default::default()
            },
        )
        .expect("settings");
    }
    f.set_state("working", None);
    f.service
        .on_hook(Some(TERM), "Stop", &payload("Stop.json", SID));
    eventually("a batch", || !f.flushes.lock().expect("lock").is_empty());
    assert_eq!(f.state(), ("done".into(), None));
    assert!(notices(&f).is_empty());
}

// ---------------------------------------------------------------------------------------------
// Codex sessions
// ---------------------------------------------------------------------------------------------

const CODEX_TERM: &str = "term-cx";
const CODEX_SESSION: &str = "sess-cx";

/// A Codex terminal on the fixture's task, its conversation id still provisional.
fn with_codex(f: &Fixture) {
    let conn = f.db.lock().expect("lock");
    crate::db::test_support::codex_terminal(
        &conn,
        &f.task_id,
        CODEX_TERM,
        CODEX_SESSION,
        "pending:aaaa",
    );
}

fn codex_row(f: &Fixture) -> agent_sessions::SessionRow {
    let conn = f.db.lock().expect("lock");
    agent_sessions::get(&conn, CODEX_SESSION).expect("codex session")
}

fn codex_fixture(file: &str) -> String {
    test_fixture(&format!("codex/{file}"))
}

/// A real Codex payload rewritten for one conversation (the captures come from several runs).
fn codex_payload(file: &str) -> String {
    let mut json: Value = serde_json::from_str(&codex_fixture(file)).expect("json");
    json["session_id"] = Value::String("01a129fc-0c89-7030-bec0-093c909a00c7".into());
    json.to_string()
}

#[test]
fn codex_session_start_adopts_the_conversation_id() {
    let f = fixture(slow_timers());
    with_codex(&f);
    let (port, token) = f.serve();
    let headers = [
        ("X-App-Token", token.as_str()),
        ("X-Terminal-Id", CODEX_TERM),
    ];
    test_post(port, &headers, &codex_fixture("SessionStart-startup.json"));
    let row = codex_row(&f);
    assert_eq!(
        row.session.conversation_id,
        "01a129fc-0c89-7030-bec0-093c909a00c7"
    );
    assert_eq!(row.session.state, SessionState::Idle);
    let conn = f.db.lock().expect("lock");
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_sessions WHERE task_id = ?1",
            [&f.task_id],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(rows, 2, "the Claude session and the Codex one, no new row");
}

#[test]
fn a_codex_turn_with_real_payloads() {
    let f = fixture(slow_timers());
    with_codex(&f);
    let (port, token) = f.serve();
    let headers = [
        ("X-App-Token", token.as_str()),
        ("X-Terminal-Id", CODEX_TERM),
    ];
    let state = || {
        let s = codex_row(&f).session;
        (s.state, s.waiting_kind)
    };
    for file in [
        "SessionStart-startup.json",
        "UserPromptSubmit.json",
        "PreToolUse-Bash.json",
    ] {
        test_post(port, &headers, &codex_payload(file));
    }
    assert_eq!(state(), (SessionState::Working, None));
    assert_eq!(
        codex_row(&f).session.activity.as_deref(),
        Some("Commande : curl -sI https://example.com | head -1")
    );
    test_post(
        port,
        &headers,
        &codex_payload("PermissionRequest-Bash.json"),
    );
    assert_eq!(
        state(),
        (SessionState::Waiting, Some(WaitingKind::Permission))
    );
    test_post(port, &headers, &codex_payload("PostToolUse-Bash.json"));
    assert_eq!(state(), (SessionState::Working, None));
    test_post(port, &headers, &codex_payload("Interrupt.json"));
    assert_ne!(state().0, SessionState::Working, "Interrupt ends the turn");
}

#[test]
fn codex_mcp_initialize_marks_the_session_ready() {
    let f = fixture(slow_timers());
    with_codex(&f);
    let (port, token) = f.serve();
    let init = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codex-mcp-client","version":"0.162.1"}}}"#;
    let headers = [
        ("X-App-Token", token.as_str()),
        ("X-Terminal-Id", CODEX_TERM),
    ];
    let (status, _) = crate::hooks::test_request(port, "POST", "/mcp", &headers, init);
    assert!(status.contains("200"), "{status}");
    eventually("the Codex session ready", || {
        codex_row(&f).session.state == SessionState::Idle
    });
    assert!(agent_sessions::is_pending_conversation(
        &codex_row(&f).session.conversation_id
    ));
}

#[test]
fn claude_mcp_initialize_changes_nothing() {
    let f = fixture(slow_timers());
    f.set_state("waiting", Some("input"));
    let (port, token) = f.serve();
    let init = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"2"}}}"#;
    let headers = [("X-App-Token", token.as_str()), ("X-Terminal-Id", TERM)];
    crate::hooks::test_request(port, "POST", "/mcp", &headers, init);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(f.state(), ("waiting".into(), s("input")));
}

#[test]
fn codex_session_exiting_without_conversation_is_paused() {
    let f = fixture(slow_timers());
    with_codex(&f);
    let (port, token) = f.serve();
    let headers = [
        ("X-App-Token", token.as_str()),
        ("X-Terminal-Id", CODEX_TERM),
    ];
    test_post(port, &headers, &codex_fixture("SessionEnd.json"));
    let mut info = f.info(Some(0));
    info.id = CODEX_TERM.into();
    info.agent_session_id = Some(CODEX_SESSION.into());
    info.agent = Some(crate::model::Agent::Codex);
    f.service.exited(&info).expect("exited");
    assert_eq!(codex_row(&f).session.state, SessionState::Paused);
}

#[test]
fn claude_and_codex_on_one_task_each_notify_with_their_name() {
    let f = fixture(slow_timers());
    with_codex(&f);
    f.set_state("working", None);
    f.service.on_hook(
        Some(CODEX_TERM),
        "UserPromptSubmit",
        &codex_payload("UserPromptSubmit.json"),
    );
    f.service
        .on_hook(Some(CODEX_TERM), "Stop", &codex_payload("Stop.json"));
    f.service.on_hook(
        Some(TERM),
        "PermissionRequest",
        &payload("PermissionRequest-Bash.json", SID),
    );
    eventually("two notices", || notices(&f).len() >= 2);
    let bodies: Vec<String> = notices(&f).into_iter().map(|n| n.body).collect();
    assert!(bodies.contains(&"Codex a fini".to_string()), "{bodies:?}");
    assert!(
        bodies.contains(&"Claude attend ta réponse".to_string()),
        "{bodies:?}"
    );
}

#[test]
fn a_new_codex_tab_resuming_a_known_conversation_takes_its_row_back() {
    let f = fixture(slow_timers());
    // The conversation of the Claude fixture session, ended: Codex's /resume picks it.
    {
        let conn = f.db.lock().expect("lock");
        conn.execute(
            "UPDATE agent_sessions SET agent = 'codex', current_terminal_id = NULL, \
             state = 'paused' WHERE id = ?1",
            [SESSION],
        )
        .expect("ended codex session");
    }
    with_codex(&f);
    let resumed =
        format!(r#"{{"hook_event_name":"SessionStart","session_id":"{SID}","source":"resume"}}"#);
    f.service
        .on_hook(Some(CODEX_TERM), "SessionStart", &resumed);
    let conn = f.db.lock().expect("lock");
    let known = agent_sessions::get(&conn, SESSION).expect("known row");
    assert_eq!(known.current_terminal_id.as_deref(), Some(CODEX_TERM));
    assert_eq!(known.session.state, SessionState::Idle);
    let pending = agent_sessions::get(&conn, CODEX_SESSION).expect("pending row");
    assert_eq!(
        pending.current_terminal_id, None,
        "the empty tab row is left"
    );
    drop(conn);
    // Later hooks of that conversation reach the known row.
    f.service.on_hook(
        Some(CODEX_TERM),
        "UserPromptSubmit",
        &format!(r#"{{"hook_event_name":"UserPromptSubmit","session_id":"{SID}","prompt":"x"}}"#),
    );
    let conn = f.db.lock().expect("lock");
    assert_eq!(
        agent_sessions::get(&conn, SESSION)
            .expect("row")
            .session
            .state,
        SessionState::Working
    );
}

#[test]
fn replies_record_how_full_the_context_is() {
    let f = fixture(slow_timers());
    let dir = tempfile::tempdir().expect("dir");
    let transcript = dir.path().join("conversation.jsonl");
    std::fs::write(
        &transcript,
        r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":149970,"output_tokens":5}}}"#,
    )
    .expect("transcript");
    let context =
        || agent_sessions::context_usage(&f.db.lock().expect("lock"), SESSION).expect("context");
    f.service.on_hook(
        Some(TERM),
        "SessionStart",
        &payload("SessionStart-startup.json", SID),
    );
    // The fixture's transcript does not exist here: nothing known yet.
    assert_eq!(context(), None);

    let mut stop: Value = serde_json::from_str(&payload("Stop.json", SID)).expect("json");
    stop["transcript_path"] = Value::String(transcript.to_string_lossy().into_owned());
    f.service.on_hook(Some(TERM), "Stop", &stop.to_string());
    let usage = context().expect("usage");
    assert_eq!(
        (usage.used, usage.limit, usage.percent),
        (150_000, 200_000, 75)
    );
    assert_eq!(usage.model.as_deref(), Some("Haiku 4.5"));
    let views =
        agent_sessions::views(&f.db.lock().expect("lock"), &[SESSION.to_string()]).expect("views");
    assert_eq!(views[0].context.as_ref().map(|c| c.percent), Some(75));

    // An unreadable transcript keeps the last usage; a compaction forgets it.
    f.service
        .on_hook(Some(TERM), "Stop", &payload("Stop.json", SID));
    assert_eq!(context().map(|c| c.percent), Some(75));
    f.service.on_hook(
        Some(TERM),
        "SessionStart",
        &payload("SessionStart-compact.json", SID),
    );
    assert_eq!(context(), None);
}
