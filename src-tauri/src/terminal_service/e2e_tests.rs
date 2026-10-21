//! End-to-end tests: the real hook server and `claude-hooks.json`,
//! `tools/fake-claude` launched through the terminal service and driven by writing to its
//! PTY, the session service wired as in `lib.rs`. Each state must be persisted and emitted
//! (the batch that `lib.rs` turns into `task_state_changed`) within 300 ms of the hook,
//! keystroke or process exit that triggers it.
//!
//! `TAIDO_FAKE_SPEED` shortens the fake's delays so that the suite stays fast.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use super::{TerminalService, HOOKS_FILE, MCP_FILE};
use crate::agents::claude;
use crate::db;
use crate::db::agent_sessions;
use crate::db::test_support::task;
use crate::error::{AppError, AppResult};
use crate::hooks::{test_serve_with_tools, HookServer, Recorder};
use crate::mcp::ToolRunner;
use crate::model::{
    Agent, CreateSubjectInput, LineKind, OpenTerminalInput, Ring, SessionState, TerminalInfo,
    TerminalKind, WaitingKind,
};
use crate::pty::{ExitHook, PtyManager, Sink, DEFAULT_BUFFER_BYTES};
use crate::session_service::{Flush, FlushSink, SessionService, Timing};
use crate::state::machine::Session;

/// Divides the fake's delays: an ordinary turn lasts 750 ms, tool steps are 125 ms apart.
const FAKE_SPEED: &str = "4";
/// Requirement: « chaque état atteint en moins de 300 ms ».
const MAX_LATENCY: Duration = Duration::from_millis(300);
const STEP_TIMEOUT: Duration = Duration::from_secs(15);

/// What happened, and when, as seen by the core.
#[derive(Default)]
struct Timeline {
    /// Hook events, when the server handed them to the session service.
    hooks: Vec<(Instant, String)>,
    /// Batches of task states, when they were emitted.
    flushes: Vec<(Instant, Flush)>,
    /// Process exits, when the PTY manager reported them.
    exits: Vec<(Instant, TerminalInfo)>,
}

/// What triggers a state change.
enum Trigger<'a> {
    /// The last hook of this name received before the change was emitted.
    Hook(&'a str),
    /// A keystroke written at this instant.
    Typed(Instant),
    /// The last process exit.
    Exit,
}

struct Rig {
    db: Arc<Mutex<Connection>>,
    sessions: Arc<SessionService>,
    terminals: TerminalService,
    timeline: Arc<Mutex<Timeline>>,
    task_id: String,
    _data_dir: tempfile::TempDir,
    _work_dir: tempfile::TempDir,
}

impl Rig {
    /// The app's wiring (`lib.rs`: `setup`, `start_terminals`, `terminal_exited`), without
    /// Tauri: a project rooted at a temp folder with one task.
    fn new() -> Rig {
        let data_dir = tempfile::tempdir().expect("data dir");
        let work_dir = tempfile::tempdir().expect("work dir");
        let conn = db::open_in_memory().expect("db");
        let subject_id = crate::db::subjects::create(
            &conn,
            &CreateSubjectInput {
                name: "Globex".into(),
                color: None,
                root_path: Some(work_dir.path().to_string_lossy().into_owned()),
                parent_id: None,
            },
        )
        .expect("subject")
        .id;
        let task_id = task(&conn, "Export CSV", Some(&subject_id), None);
        let db = Arc::new(Mutex::new(conn));
        let timeline = Arc::new(Mutex::new(Timeline::default()));

        let seen = Arc::clone(&timeline);
        let sink: FlushSink = Arc::new(move |flush| {
            let at = Instant::now();
            seen.lock().expect("timeline").flushes.push((at, flush));
        });
        let sessions = Arc::new(SessionService::new(
            Arc::clone(&db),
            sink,
            Timing {
                starting_timeout: Duration::from_secs(60),
                ..Timing::default()
            },
        ));

        let server = HookServer::bind().expect("bind");
        let settings = serde_json::to_string_pretty(&claude::hooks_settings(
            crate::i18n::Language::Fr,
            server.port,
        ))
        .expect("settings json");
        claude::write_private(&data_dir.path().join(HOOKS_FILE), &settings).expect("settings");
        let mcp = serde_json::to_string_pretty(&claude::mcp_config(server.port)).expect("mcp json");
        claude::write_private(&data_dir.path().join(MCP_FILE), &mcp).expect("mcp file");
        let token = server.token.clone();
        let port = server.port;
        let (seen, routed) = (Arc::clone(&timeline), Arc::clone(&sessions));
        let recorder: Recorder = Arc::new(move |terminal_id, event, payload| {
            let at = Instant::now();
            seen.lock()
                .expect("timeline")
                .hooks
                .push((at, event.to_string()));
            routed.on_hook(terminal_id, event, payload);
        });
        let tool_db = Arc::clone(&db);
        let tools: ToolRunner = Arc::new(move |terminal, name, args| {
            let conn = tool_db.lock().expect("db");
            crate::mcp::tools::run(&conn, terminal, name, args).result
        });
        test_serve_with_tools(server, recorder, tools);

        let (seen, exited) = (Arc::clone(&timeline), Arc::clone(&sessions));
        let on_exit: ExitHook = Arc::new(move |info: &TerminalInfo| {
            let at = Instant::now();
            seen.lock()
                .expect("timeline")
                .exits
                .push((at, info.clone()));
            exited.exited(info).expect("exit recorded");
        });
        let terminals = TerminalService::new(
            PtyManager::new(DEFAULT_BUFFER_BYTES, on_exit),
            data_dir.path().to_path_buf(),
            token,
            port,
            super::AgentOverrides {
                claude: Some(crate::agents::fake_bin("fake-claude")),
                codex: Some(crate::agents::fake_bin("fake-codex")),
            },
        );
        let mut env = crate::env::resolve();
        env.vars
            .insert("TAIDO_FAKE_SPEED".into(), FAKE_SPEED.into());
        assert!(terminals.env.set(env).is_ok(), "environment set once");

        Rig {
            db,
            sessions,
            terminals,
            timeline,
            task_id,
            _data_dir: data_dir,
            _work_dir: work_dir,
        }
    }

    /// `open_terminal` for Claude.
    fn open_claude(&self) -> TerminalInfo {
        let input = OpenTerminalInput {
            task_id: self.task_id.clone(),
            kind: TerminalKind::Agent,
            agent: None,
            command: None,
            initial_prompt: None,
            permission_mode: None,
            add_task_context: None,
            cols: 100,
            rows: 30,
        };
        let info = self.terminals.open(&self.db, &input).expect("open");
        self.sessions.launched(&info);
        info
    }

    /// `write_terminal`: the PTY write, then the Escape rule. Returns the instant of the write.
    fn type_text(&self, terminal_id: &str, data: &str) -> Instant {
        let at = Instant::now();
        self.terminals
            .pty
            .write(terminal_id, data.as_bytes())
            .expect("write");
        self.sessions.typed(terminal_id, data).expect("typed");
        at
    }

    fn output_until(&self, terminal_id: &str, needle: &str) -> String {
        let deadline = Instant::now() + STEP_TIMEOUT;
        loop {
            let data = Arc::new(Mutex::new(Vec::new()));
            let d = Arc::clone(&data);
            let sink: Sink = Box::new(move |bytes| {
                d.lock().expect("lock").extend_from_slice(&bytes);
                true
            });
            // The output of an exited terminal stays readable until it is removed.
            if self.terminals.pty.attach(terminal_id, sink).is_ok() {
                let text = String::from_utf8_lossy(&data.lock().expect("lock")).into_owned();
                if text.contains(needle) {
                    return text;
                }
                assert!(Instant::now() < deadline, "no {needle:?} in {text:?}");
            }
            assert!(Instant::now() < deadline, "terminal {terminal_id} is gone");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn session(&self, info: &TerminalInfo) -> Session {
        let id = info.agent_session_id.as_deref().expect("agent session");
        let conn = self.db.lock().expect("db");
        agent_sessions::get(&conn, id).expect("session").session
    }

    fn flush_count(&self) -> usize {
        self.timeline.lock().expect("timeline").flushes.len()
    }

    fn hook_count(&self, name: &str) -> usize {
        let t = self.timeline.lock().expect("timeline");
        t.hooks.iter().filter(|(_, n)| n == name).count()
    }

    fn wait_hooks(&self, name: &str, count: usize) {
        let deadline = Instant::now() + STEP_TIMEOUT;
        while self.hook_count(name) < count {
            assert!(Instant::now() < deadline, "no {name} hook #{count}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Waits for a batch, from batch number `from`, that shows the task with `ring` and a
    /// second line of `line`; checks it came within [`MAX_LATENCY`] of its trigger. Returns
    /// the number of the next batch to look at.
    fn expect(
        &self,
        from: usize,
        ring: Ring,
        line: Option<LineKind>,
        trigger: Trigger<'_>,
    ) -> usize {
        let deadline = Instant::now() + STEP_TIMEOUT;
        loop {
            {
                let t = self.timeline.lock().expect("timeline");
                let found = t.flushes.iter().enumerate().skip(from).find(|(_, (_, f))| {
                    f.changes.iter().any(|c| {
                        c.task_id == self.task_id
                            && c.ring == ring
                            && c.line.as_ref().map(|l| l.kind) == line
                    })
                });
                if let Some((index, (emitted, flush))) = found {
                    self.check_batch(flush);
                    let triggered = match trigger {
                        Trigger::Hook(name) => t
                            .hooks
                            .iter()
                            .rev()
                            .find(|(at, n)| n == name && at <= emitted)
                            .map(|(at, _)| *at)
                            .unwrap_or_else(|| panic!("{ring:?} emitted before any {name}")),
                        Trigger::Typed(at) => at,
                        Trigger::Exit => t.exits.last().expect("an exit").0,
                    };
                    let latency = emitted.saturating_duration_since(triggered);
                    eprintln!("{ring:?} ({line:?}) emitted {latency:?} after its trigger");
                    assert!(
                        latency <= MAX_LATENCY,
                        "{ring:?} ({line:?}) emitted {latency:?} after its trigger"
                    );
                    return index + 1;
                }
            }
            assert!(
                Instant::now() < deadline,
                "{ring:?} ({line:?}) never emitted"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// One change per task in a batch, the subject id filled, fresh counters.
    fn check_batch(&self, flush: &Flush) {
        let ours: Vec<_> = flush
            .changes
            .iter()
            .filter(|c| c.task_id == self.task_id)
            .collect();
        assert_eq!(ours.len(), 1, "one change per task and batch");
        assert!(ours[0].subject_id.is_some());
        let counts = flush.counts.as_ref().expect("counts in every batch");
        let waiting = u32::from(ours[0].ring == Ring::Waiting);
        assert_eq!(counts.waiting, waiting, "red counter follows the ring");
    }

    fn assert_state(&self, info: &TerminalInfo, state: SessionState, kind: Option<WaitingKind>) {
        let s = self.session(info);
        assert_eq!((s.state, s.waiting_kind), (state, kind), "persisted state");
    }
}

#[test]
fn fake_claude_goes_through_every_state_in_time() {
    let rig = Rig::new();
    let term = rig.open_claude();
    let id = term.id.as_str();

    // Launch: Starting, then Idle on SessionStart (relayed by the curl command hook).
    let mut next = rig.expect(
        0,
        Ring::Idle,
        Some(LineKind::Idle),
        Trigger::Hook("SessionStart"),
    );
    rig.output_until(id, "READY");
    rig.assert_state(&term, SessionState::Idle, None);

    // An ordinary turn: Working on UserPromptSubmit, Done on Stop.
    rig.type_text(id, "Bonjour\r");
    next = rig.expect(
        next,
        Ring::Working,
        Some(LineKind::Working),
        Trigger::Hook("UserPromptSubmit"),
    );
    next = rig.expect(
        next,
        Ring::Done,
        Some(LineKind::Done),
        Trigger::Hook("Stop"),
    );
    rig.assert_state(&term, SessionState::Done, None);
    assert_eq!(
        rig.session(&term).last_message.as_deref(),
        Some("OK, c'est fait.")
    );

    // `/p`: Waiting(Permission) on PermissionRequest; the server answers `{}` at once, then
    // the answer typed in the terminal runs the tool and the turn ends.
    rig.type_text(id, "/p\r");
    next = rig.expect(
        next,
        Ring::Waiting,
        Some(LineKind::WaitingPermission),
        Trigger::Hook("PermissionRequest"),
    );
    rig.output_until(id, "DECISION:{}");
    rig.assert_state(&term, SessionState::Waiting, Some(WaitingKind::Permission));
    let pending = rig.session(&term).pending_permission.expect("pending");
    assert_eq!(pending.summary, "Commande : touch fake-claude.txt");
    rig.type_text(id, "1\r");
    next = rig.expect(
        next,
        Ring::Done,
        Some(LineKind::Done),
        Trigger::Hook("Stop"),
    );
    rig.assert_state(&term, SessionState::Done, None);
    assert!(rig.session(&term).pending_permission.is_none());

    // `/q`: a final question → Waiting(Question).
    rig.type_text(id, "/q\r");
    next = rig.expect(
        next,
        Ring::Waiting,
        Some(LineKind::WaitingQuestion),
        Trigger::Hook("Stop"),
    );
    rig.assert_state(&term, SessionState::Waiting, Some(WaitingKind::Question));
    assert_eq!(
        rig.session(&term).last_message.as_deref(),
        Some("Tu veux un café ?")
    );

    // `/e`: StopFailure(rate_limit) → Error.
    rig.type_text(id, "/e\r");
    next = rig.expect(
        next,
        Ring::Error,
        Some(LineKind::Error),
        Trigger::Hook("StopFailure"),
    );
    rig.assert_state(&term, SessionState::Error, None);
    assert_eq!(rig.session(&term).error_kind.as_deref(), Some("rate_limit"));

    // Escape during a turn: Idle at once, without any hook. Sent right after a
    // tool step so that no hook of the interrupted turn is still on its way.
    let posts = rig.hook_count("PostToolUse");
    rig.type_text(id, "Encore\r");
    next = rig.expect(
        next,
        Ring::Working,
        Some(LineKind::Working),
        Trigger::Hook("UserPromptSubmit"),
    );
    rig.wait_hooks("PostToolUse", posts + 1);
    let escape = rig.type_text(id, "\x1b");
    next = rig.expect(
        next,
        Ring::Idle,
        Some(LineKind::Idle),
        Trigger::Typed(escape),
    );
    rig.output_until(id, "Interrupted");
    // The interrupted turn sends nothing more: the session stays Idle.
    std::thread::sleep(Duration::from_millis(400));
    rig.assert_state(&term, SessionState::Idle, None);
    assert_eq!(
        rig.hook_count("Stop"),
        3,
        "the interrupted turn never stopped"
    );

    // `/exit`: SessionEnd, then the process exits 0 → Paused: a plain task again in lists
    // (ring Human, no row line).
    rig.type_text(id, "/exit\r");
    rig.expect(next, Ring::Human, None, Trigger::Exit);
    rig.assert_state(&term, SessionState::Paused, None);
    let s = rig.session(&term);
    assert!(s.ended_cleanly);
    assert_eq!(rig.hook_count("SessionEnd"), 1);
    let exits = rig.timeline.lock().expect("timeline").exits.len();
    assert_eq!(exits, 1);
    rig.terminals.shutdown(&rig.db);
}

#[test]
fn a_fake_claude_crash_shows_crashed_in_time() {
    let rig = Rig::new();
    let term = rig.open_claude();
    let id = term.id.as_str();
    let next = rig.expect(
        0,
        Ring::Idle,
        Some(LineKind::Idle),
        Trigger::Hook("SessionStart"),
    );
    rig.output_until(id, "READY");

    // `/x`: exit code 1 without SessionEnd → Crashed.
    let typed = rig.type_text(id, "/x\r");
    let after = rig.expect(next, Ring::Crashed, Some(LineKind::Crashed), Trigger::Exit);
    let emitted = rig.timeline.lock().expect("timeline").flushes[after - 1].0;
    eprintln!("Crashed emitted {:?} after `/x` was typed", emitted - typed);
    rig.assert_state(&term, SessionState::Crashed, None);
    assert!(!rig.session(&term).ended_cleanly);
    let exit_code = rig.timeline.lock().expect("timeline").exits[0].1.exit_code;
    assert_eq!(exit_code, Some(1));
    assert_eq!(rig.hook_count("SessionEnd"), 0);
    assert!(rig.flush_count() >= 2);
    rig.terminals.shutdown(&rig.db);
}
/// A conversation that ended (here `/exit`) comes back with « Reprendre »:
/// `--resume <id>` in a new tab, the same session row, its trace kept and extended.
#[test]
fn a_finished_conversation_is_resumed_in_a_new_tab() {
    use crate::db::history;
    use crate::model::{ExchangeKind, ResumeSessionInput};

    let rig = Rig::new();
    let first = rig.open_claude();
    rig.wait_hooks("SessionStart", 1);
    rig.output_until(&first.id, "READY");
    rig.type_text(&first.id, "bonjour\r");
    rig.wait_hooks("Stop", 1);
    rig.type_text(&first.id, "/exit\r");
    rig.wait_hooks("SessionEnd", 1);
    let deadline = Instant::now() + STEP_TIMEOUT;
    while rig.timeline.lock().expect("timeline").exits.is_empty() {
        assert!(Instant::now() < deadline, "fake claude never exited");
        std::thread::sleep(Duration::from_millis(5));
    }
    let session_id = first.agent_session_id.clone().expect("session");
    let claude_id = rig.session(&first).conversation_id;
    // The project's folder changes meanwhile: Claude keeps the conversation under the folder
    // it ran in, so the resume goes there.
    let original_cwd = first.cwd.clone();
    let moved = tempfile::tempdir().expect("new project folder");
    rig.db
        .lock()
        .expect("db")
        .execute(
            "UPDATE subjects SET root_path = ?1",
            [moved.path().to_string_lossy()],
        )
        .expect("move project");

    // Nothing to resume without a message; the conversation has one here.
    let summary = {
        let conn = rig.db.lock().expect("db");
        history::sessions_of_task(&conn, &rig.task_id, |_| false).expect("history")
    };
    assert_eq!(summary.len(), 1);
    assert!(summary[0].resumable);
    assert_eq!(summary[0].first_prompt.as_deref(), Some("bonjour"));

    let resumed = rig
        .terminals
        .resume(
            &rig.db,
            &ResumeSessionInput {
                agent_session_id: session_id.clone(),
                cols: 100,
                rows: 30,
            },
        )
        .expect("resume");
    rig.sessions.launched(&resumed);
    assert_ne!(resumed.id, first.id, "a new tab");
    assert_eq!(
        resumed.agent_session_id.as_deref(),
        Some(session_id.as_str())
    );
    let out = rig.output_until(&resumed.id, "READY");
    assert_eq!(resumed.cwd, original_cwd);
    let canon = crate::db::test_support::reported_cwd(std::path::Path::new(&original_cwd));
    assert!(
        out.contains(&format!("CWD:{}", canon.to_string_lossy())),
        "{out}"
    );
    // The old tab, kept with « Terminé », no longer shows this conversation (#1).
    assert_eq!(
        rig.terminals
            .pty
            .info(&first.id)
            .expect("old tab kept")
            .agent_session_id,
        None
    );
    assert!(out.contains("ARG:--resume"), "{out}");
    assert!(out.contains(&format!("ARG:{claude_id}")), "{out}");
    assert!(out.contains("ARG:--settings"), "settings passed again");
    rig.wait_hooks("SessionStart", 2);
    let deadline = Instant::now() + STEP_TIMEOUT;
    while rig.session(&resumed).state != SessionState::Idle {
        assert!(Instant::now() < deadline, "resumed session never Idle");
        std::thread::sleep(Duration::from_millis(5));
    }

    // Still one session: the same row, now in the new tab, refused a second resume.
    let conn = rig.db.lock().expect("db");
    let row = agent_sessions::get(&conn, &session_id).expect("row");
    assert_eq!(
        row.current_terminal_id.as_deref(),
        Some(resumed.id.as_str())
    );
    let kinds: Vec<ExchangeKind> = history::exchanges(&conn, &session_id)
        .expect("trace")
        .into_iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        kinds,
        [
            ExchangeKind::Prompt,
            ExchangeKind::Reply,
            ExchangeKind::Resumed
        ]
    );
    drop(conn);
    let again = rig.terminals.resume(
        &rig.db,
        &ResumeSessionInput {
            agent_session_id: session_id,
            cols: 100,
            rows: 30,
        },
    );
    assert!(
        matches!(again, Err(AppError::Invalid(_))),
        "already in a tab"
    );
    rig.terminals.shutdown(&rig.db);
}

/// `/clear` in a running tab: the old conversation becomes history, the tab follows the new
/// one (driven by the real hook flow of the fake).
#[test]
fn clear_starts_a_new_conversation_in_the_same_tab() {
    let rig = Rig::new();
    let term = rig.open_claude();
    rig.wait_hooks("SessionStart", 1);
    rig.output_until(&term.id, "READY");
    rig.type_text(&term.id, "avant\r");
    rig.wait_hooks("Stop", 1);
    rig.type_text(&term.id, "/clear\r");
    rig.wait_hooks("SessionStart", 2);
    let old_id = term.agent_session_id.clone().expect("session");
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let conn = rig.db.lock().expect("db");
        let current = agent_sessions::by_terminal(&conn, &term.id).expect("query");
        if current.as_ref().is_some_and(|r| r.id != old_id) {
            let old = agent_sessions::get(&conn, &old_id).expect("old");
            assert_eq!(old.current_terminal_id, None);
            assert_eq!(old.session.state, SessionState::Paused);
            let list = crate::db::history::sessions_of_task(&conn, &rig.task_id, |t| t == term.id)
                .expect("history");
            assert_eq!(list.len(), 2);
            assert_eq!(list[1].id, old_id);
            assert!(list[1].resumable && !list[1].crashed);
            break;
        }
        drop(conn);
        assert!(
            Instant::now() < deadline,
            "the tab never switched conversation"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    rig.terminals.shutdown(&rig.db);
}

/// A Claude session adds a subtask and a note paragraph to its task through the app's MCP
/// server: terminal → fake-claude → `--mcp-config` → `POST /mcp` → database.
#[test]
fn claude_adds_a_subtask_and_a_note_through_the_app_server() {
    let rig = Rig::new();
    let info = rig.open_claude();
    rig.output_until(&info.id, "READY");

    rig.type_text(
        &info.id,
        "/mcp create_subtask {\"title\":\"Acheter du pain\"}\r",
    );
    let out = rig.output_until(&info.id, "MCP:");
    assert!(out.contains("Added the subtask"), "{out}");
    rig.type_text(
        &info.id,
        "/mcp add_to_note {\"text\":\"Rappeler le plombier\"}\r",
    );
    rig.output_until(&info.id, "Added to the note");

    let conn = rig.db.lock().expect("db");
    let detail = crate::db::tasks::detail(&conn, &rig.task_id).expect("detail");
    assert_eq!(detail.subtasks.len(), 1);
    assert_eq!(detail.subtasks[0].text, "Acheter du pain");
    assert_eq!(detail.description, "Rappeler le plombier");
    drop(conn);
    rig.terminals.shutdown(&rig.db);
}

// ---------------------------------------------------------------------------------------------
// Codex: `tools/fake-codex` through the same wiring.
// ---------------------------------------------------------------------------------------------

impl Rig {
    fn set_default_agent(&self, agent: Agent) {
        let conn = self.db.lock().expect("db");
        crate::db::settings::update(
            &conn,
            &crate::model::SettingsPatch {
                default_agent: Some(agent),
                ..Default::default()
            },
        )
        .expect("default agent");
    }

    /// `open_terminal` for the default agent (⌘T).
    fn open_default(&self) -> AppResult<TerminalInfo> {
        let input = OpenTerminalInput {
            task_id: self.task_id.clone(),
            kind: TerminalKind::Agent,
            agent: None,
            command: None,
            initial_prompt: None,
            permission_mode: None,
            add_task_context: None,
            cols: 100,
            rows: 30,
        };
        let info = self.terminals.open(&self.db, &input)?;
        self.sessions.launched(&info);
        Ok(info)
    }

    fn wait_exit(&self, count: usize) {
        let deadline = Instant::now() + STEP_TIMEOUT;
        while self.timeline.lock().expect("timeline").exits.len() < count {
            assert!(Instant::now() < deadline, "no exit #{count}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn resume(&self, session_id: &str) -> AppResult<TerminalInfo> {
        let info = self.terminals.resume(
            &self.db,
            &crate::model::ResumeSessionInput {
                agent_session_id: session_id.to_string(),
                cols: 100,
                rows: 30,
            },
        )?;
        self.sessions.launched(&info);
        Ok(info)
    }
}

#[test]
fn a_codex_session_goes_ready_working_then_done() {
    let rig = Rig::new();
    rig.set_default_agent(Agent::Codex);
    let term = rig.open_default().expect("open codex");
    assert_eq!(term.agent, Some(Agent::Codex));
    let out = rig.output_until(&term.id, "READY");
    assert!(out.contains("fake-codex started"), "{out}");
    assert!(out.contains("ARG:--no-daemon"), "{out}");
    // Ready once Codex connects to the app's MCP server (no SessionStart before a message).
    let mut next = rig.expect(
        0,
        Ring::Idle,
        Some(LineKind::Idle),
        Trigger::Hook("AgentReady"),
    );
    rig.type_text(&term.id, "Bonjour\r");
    next = rig.expect(
        next,
        Ring::Working,
        Some(LineKind::Working),
        Trigger::Hook("UserPromptSubmit"),
    );
    rig.expect(
        next,
        Ring::Done,
        Some(LineKind::Done),
        Trigger::Hook("Stop"),
    );
    let conversation = rig.session(&term).conversation_id;
    assert!(!agent_sessions::is_pending_conversation(&conversation));
    rig.terminals.shutdown(&rig.db);
}

#[test]
fn a_codex_session_is_resumed_with_codex_even_when_claude_is_the_default() {
    let rig = Rig::new();
    rig.set_default_agent(Agent::Codex);
    let first = rig.open_default().expect("open codex");
    rig.output_until(&first.id, "READY");
    rig.type_text(&first.id, "bonjour\r");
    rig.wait_hooks("Stop", 1);
    let conversation = rig.session(&first).conversation_id;
    rig.type_text(&first.id, "/exit\r");
    rig.wait_exit(1);

    rig.set_default_agent(Agent::Claude);
    let session_id = first.agent_session_id.clone().expect("session");
    let resumed = rig.resume(&session_id).expect("resume");
    assert_eq!(resumed.agent, Some(Agent::Codex));
    let out = rig.output_until(&resumed.id, "READY");
    assert!(out.contains("fake-codex started"), "{out}");
    assert!(out.contains("ARG:resume"), "{out}");
    assert!(out.contains(&format!("ARG:{conversation}")), "{out}");
    rig.terminals.shutdown(&rig.db);
}

#[test]
fn a_claude_session_is_resumed_with_claude_when_codex_is_the_default() {
    let rig = Rig::new();
    let first = rig.open_claude();
    rig.output_until(&first.id, "READY");
    rig.type_text(&first.id, "bonjour\r");
    rig.wait_hooks("Stop", 1);
    rig.type_text(&first.id, "/exit\r");
    rig.wait_exit(1);
    rig.set_default_agent(Agent::Codex);
    let resumed = rig
        .resume(first.agent_session_id.as_deref().expect("session"))
        .expect("resume");
    assert_eq!(resumed.agent, Some(Agent::Claude));
    let out = rig.output_until(&resumed.id, "READY");
    assert!(out.contains("fake-claude started"), "{out}");
    rig.terminals.shutdown(&rig.db);
}

#[test]
fn a_codex_session_without_message_cannot_be_resumed() {
    let rig = Rig::new();
    rig.set_default_agent(Agent::Codex);
    let first = rig.open_default().expect("open codex");
    rig.output_until(&first.id, "READY");
    rig.type_text(&first.id, "/exit\r");
    // The hook is handled before the exit, as in a real session.
    rig.wait_hooks("SessionEnd", 1);
    rig.wait_exit(1);
    {
        let t = rig.timeline.lock().expect("timeline");
        let base = t.exits[0].0;
        for (at, name) in &t.hooks {
            let d = at.saturating_duration_since(base).as_millis() as i128
                - base.saturating_duration_since(*at).as_millis() as i128;
            eprintln!("DIAG hook {name} at {d} ms relative to exit");
        }
        eprintln!("DIAG exit code {:?}", t.exits[0].1.exit_code);
    }
    eprintln!("DIAG state {:?}", rig.session(&first).state);
    eprintln!("DIAG output {:?}", rig.output_until(&first.id, "READY"));
    let session_id = first.agent_session_id.clone().expect("session");
    assert!(matches!(rig.resume(&session_id), Err(AppError::Invalid(_))));
    assert_eq!(rig.session(&first).state, SessionState::Paused);
}

#[test]
fn a_missing_codex_is_reported_without_falling_back_to_claude() {
    let mut rig = Rig::new();
    rig.terminals
        .set_codex_override(Some("/nonexistent/codex".into()));
    rig.set_default_agent(Agent::Codex);
    assert!(matches!(rig.open_default(), Err(AppError::CodexMissing)));
    let conn = rig.db.lock().expect("db");
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM agent_sessions", [], |r| r.get(0))
        .expect("count");
    assert_eq!(sessions, 0);
}

#[test]
fn codex_adds_a_subtask_through_the_app_server() {
    let rig = Rig::new();
    rig.set_default_agent(Agent::Codex);
    let info = rig.open_default().expect("open codex");
    rig.output_until(&info.id, "READY");
    rig.type_text(
        &info.id,
        "/mcp create_subtask {\"title\":\"Acheter du lait\"}\r",
    );
    let out = rig.output_until(&info.id, "MCP:");
    assert!(out.contains("Added the subtask"), "{out}");
    let conn = rig.db.lock().expect("db");
    let detail = crate::db::tasks::detail(&conn, &rig.task_id).expect("detail");
    assert_eq!(detail.subtasks[0].text, "Acheter du lait");
    drop(conn);
    rig.terminals.shutdown(&rig.db);
}
