//! Service tests with real PTYs and `tools/fake-claude` (never the real Claude).

use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use super::AgentOverrides;
use super::*;
use crate::db::test_support::task;
use crate::model::{CreateSubjectInput, PermissionMode, TerminalInfo};
use crate::pty::{ExitHook, Sink, DEFAULT_BUFFER_BYTES};

fn fake_claude() -> String {
    crate::agents::fake_bin("fake-claude")
}

struct Fixture {
    db: Mutex<Connection>,
    service: TerminalService,
    exits: mpsc::Receiver<TerminalInfo>,
    data_dir: tempfile::TempDir,
    work_dir: tempfile::TempDir,
}

fn fixture(claude: Option<&str>) -> Fixture {
    let (tx, exits) = mpsc::channel();
    let tx = Mutex::new(tx);
    let hook: ExitHook = Arc::new(move |info: &TerminalInfo| {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(info.clone());
        }
    });
    let data_dir = tempfile::tempdir().expect("data dir");
    let work_dir = tempfile::tempdir().expect("work dir");
    let service = TerminalService::new(
        PtyManager::new(DEFAULT_BUFFER_BYTES, hook),
        data_dir.path().to_path_buf(),
        "secret-token".into(),
        4242,
        AgentOverrides {
            claude: claude.map(str::to_string),
            codex: None,
        },
    );
    Fixture {
        db: Mutex::new(db::open_in_memory().expect("db")),
        service,
        exits,
        data_dir,
        work_dir,
    }
}

impl Fixture {
    /// A project rooted at the work dir, with one task.
    fn task_with_folder(&self) -> String {
        let conn = self.db.lock().expect("lock");
        let s = crate::db::subjects::create(
            &conn,
            &CreateSubjectInput {
                name: "Globex".into(),
                color: None,
                root_path: Some(self.work_dir.path().to_string_lossy().into_owned()),
                parent_id: None,
            },
        )
        .expect("subject")
        .id;
        task(&conn, "Export CSV", Some(&s), None)
    }

    fn input(&self, task_id: &str, kind: TerminalKind) -> OpenTerminalInput {
        OpenTerminalInput {
            task_id: task_id.into(),
            kind,
            agent: None,
            command: None,
            initial_prompt: None,
            permission_mode: None,
            add_task_context: None,
            cols: 100,
            rows: 30,
        }
    }

    fn output_until(&self, id: &str, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let data = Arc::new(Mutex::new(Vec::new()));
            let d = data.clone();
            let sink: Sink = Box::new(move |bytes| {
                d.lock().expect("lock").extend_from_slice(&bytes);
                true
            });
            self.service.pty.attach(id, sink).expect("attach");
            let text = String::from_utf8_lossy(&data.lock().expect("lock")).into_owned();
            if text.contains(needle) {
                return text;
            }
            assert!(Instant::now() < deadline, "no {needle:?} in {text:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn count(&self, table: &str) -> i64 {
        self.db
            .lock()
            .expect("lock")
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .expect("count")
    }
}

#[test]
fn claude_is_launched_with_the_spec_arguments_and_environment() {
    let f = fixture(Some(&fake_claude()));
    let t = f.task_with_folder();
    let mut input = f.input(&t, TerminalKind::Agent);
    input.initial_prompt = Some("Export CSV\n\nAvec les colonnes".into());
    input.permission_mode = Some(PermissionMode::AcceptEdits);
    let info = f.service.open(&f.db, &input).expect("open");
    assert!(info.running);
    let session_id = info.agent_session_id.clone().expect("session");
    let out = f.output_until(&info.id, "READY");

    let args: Vec<&str> = out
        .lines()
        // ConPTY prefixes the first line with terminal escape sequences.
        .filter_map(|l| l.trim_end_matches('\r').split_once("ARG:").map(|(_, a)| a))
        .collect();
    let claude_id = args[1];
    assert_eq!(args[0], "--session-id");
    assert!(uuid::Uuid::parse_str(claude_id).is_ok());
    assert_eq!(
        args[2..4],
        ["--settings", &*f.service.hooks_file().to_string_lossy()]
    );
    assert_eq!(
        args[4..6],
        ["--mcp-config", &*f.service.mcp_file().to_string_lossy()]
    );
    assert_eq!(args[6..8], ["--name", "Globex · Export CSV"]);
    assert_eq!(args[8..10], ["--permission-mode", "acceptEdits"]);
    assert_eq!(args[10], "--append-system-prompt-file");
    let context = std::fs::read_to_string(args[11]).expect("context file");
    assert!(context.contains("- Task: Export CSV"));
    assert!(args[11].starts_with(&*f.data_dir.path().to_string_lossy()));
    // The prompt has a newline: the fake prints it over two ARG lines.
    assert!(out.contains("ARG:Export CSV"));
    let cwd = std::fs::canonicalize(f.work_dir.path()).expect("canon");
    assert!(
        out.contains(&format!("CWD:{}", cwd.to_string_lossy())),
        "{out}"
    );
    assert!(out.contains(&format!("TERMINAL:{}", info.id)));
    assert!(out.contains("TOKEN:set"));
    assert!(
        out.contains("NESTED:no"),
        "Claude Code session variables are stripped"
    );

    let (state, stored_uuid): (String, String) =
        f.db.lock()
            .expect("lock")
            .query_row(
                "SELECT state, conversation_id FROM agent_sessions WHERE id = ?1",
                [&session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("session row");
    assert_eq!(state, "starting");
    assert_eq!(stored_uuid, claude_id);

    f.service.pty.write(&info.id, b"bonjour\n").expect("write");
    f.output_until(&info.id, "GOT:bonjour");
    f.service.shutdown(&f.db);
}

#[test]
fn without_task_context_no_file_is_passed() {
    let f = fixture(Some(&fake_claude()));
    let t = f.task_with_folder();
    let mut input = f.input(&t, TerminalKind::Agent);
    input.add_task_context = Some(false);
    let info = f.service.open(&f.db, &input).expect("open");
    let out = f.output_until(&info.id, "READY");
    assert!(!out.contains("--append-system-prompt-file"));
    assert!(!out.contains("--permission-mode"), "Normal passes no mode");
    f.service.shutdown(&f.db);
}

#[test]
fn folder_and_binary_errors_create_nothing() {
    let f = fixture(Some(crate::abs!("/nope/fake-claude")));
    let inbox = task(&f.db.lock().expect("lock"), "Sans dossier", None, None);
    assert!(matches!(
        f.service.open(&f.db, &f.input(&inbox, TerminalKind::Shell)),
        Err(AppError::NoFolder(_))
    ));
    f.db.lock()
        .expect("lock")
        .execute(
            "UPDATE tasks SET workdir_override = '/nope/gone' WHERE id = ?1",
            [&inbox],
        )
        .expect("override");
    assert!(matches!(
        f.service.open(&f.db, &f.input(&inbox, TerminalKind::Shell)),
        Err(AppError::FolderMissing(_))
    ));
    let t = f.task_with_folder();
    assert!(matches!(
        f.service.open(&f.db, &f.input(&t, TerminalKind::Agent)),
        Err(AppError::ClaudeMissing)
    ));
    let mut empty = f.input(&t, TerminalKind::Command);
    empty.command = Some("  ".into());
    assert!(matches!(
        f.service.open(&f.db, &empty),
        Err(AppError::Invalid(_))
    ));
    assert_eq!(f.count("terminals"), 0);
    assert_eq!(f.count("agent_sessions"), 0);
    assert!(f.service.pty.list().is_empty());
}

fn set_claude_path(f: &Fixture, path: &str) {
    settings::update(
        &f.db.lock().expect("lock"),
        &crate::model::SettingsPatch {
            claude_path: Some(path.into()),
            ..Default::default()
        },
    )
    .expect("settings");
}

#[test]
fn the_claude_path_setting_is_read_at_each_launch() {
    let f = fixture(None);
    let t = f.task_with_folder();
    set_claude_path(&f, crate::abs!("/nope/claude"));
    assert!(matches!(
        f.service.open(&f.db, &f.input(&t, TerminalKind::Agent)),
        Err(AppError::ClaudeMissing)
    ));
    assert_eq!(f.count("terminals"), 0);
    // Changed in Réglages: the next launch uses it, without restarting.
    set_claude_path(&f, &fake_claude());
    let info = f
        .service
        .open(&f.db, &f.input(&t, TerminalKind::Agent))
        .expect("open");
    f.output_until(&info.id, "READY");
    f.service.shutdown(&f.db);
}

#[test]
fn the_override_wins_over_the_claude_path_setting() {
    let f = fixture(Some(&fake_claude()));
    let t = f.task_with_folder();
    set_claude_path(&f, crate::abs!("/nope/claude"));
    let info = f
        .service
        .open(&f.db, &f.input(&t, TerminalKind::Agent))
        .expect("open");
    f.output_until(&info.id, "READY");
    f.service.shutdown(&f.db);
}

// Unix only: the stand-in is a shell script.
#[cfg(unix)]
#[test]
fn check_claude_uses_the_binary_a_launch_would_use() {
    let f = fixture(None);
    let script = f.work_dir.path().join("my-claude");
    std::fs::write(
        &script,
        "#!/bin/sh\ncase \"$1\" in -v) echo '9.8.7 (Claude Code)';; \
         auth) echo '{\"loggedIn\": false}';; esac\n",
    )
    .expect("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    let path = script.to_string_lossy().into_owned();
    set_claude_path(&f, &path);
    let status = f
        .service
        .check_agent(&f.db, crate::model::Agent::Claude, Duration::from_secs(5))
        .expect("check");
    assert_eq!(
        status,
        AgentStatus {
            path: Some(path),
            version: Some("9.8.7".into()),
            logged_in: Some(false),
        }
    );
    set_claude_path(&f, crate::abs!("/nope/claude"));
    let missing = f
        .service
        .check_agent(&f.db, crate::model::Agent::Claude, Duration::from_secs(5))
        .expect("check");
    assert_eq!(missing.path, None);
}

#[test]
fn a_command_runs_in_the_login_shell_and_its_exit_is_reported() {
    let f = fixture(None);
    let t = f.task_with_folder();
    let mut input = f.input(&t, TerminalKind::Command);
    // The login shell on macOS, PowerShell on Windows.
    let command = if cfg!(windows) {
        "Write-Output \"hello $(40 + 2)\"; exit 7"
    } else {
        "echo \"hello $((40 + 2))\"; exit 7"
    };
    input.command = Some(command.into());
    let info = f.service.open(&f.db, &input).expect("open");
    assert_eq!(info.command.as_deref(), Some(command));
    let exited = f.exits.recv_timeout(Duration::from_secs(15)).expect("exit");
    assert_eq!(exited.exit_code, Some(7));
    f.output_until(&info.id, "hello 42");
    assert_eq!(f.service.pty.info(&info.id).map(|i| i.running), Some(false));
}

#[test]
fn closing_marks_the_terminal_closed_by_user_then_stops_it() {
    let f = fixture(None);
    let t = f.task_with_folder();
    let mut input = f.input(&t, TerminalKind::Command);
    input.command = Some("sleep 300".into());
    let info = f.service.open(&f.db, &input).expect("open");
    f.service.close(&f.db, &info.id).expect("close");
    assert!(f.service.pty.info(&info.id).is_none());
    let by_user: bool =
        f.db.lock()
            .expect("lock")
            .query_row(
                "SELECT closed_by_user FROM terminals WHERE id = ?1",
                [&info.id],
                |r| r.get(0),
            )
            .expect("row");
    assert!(by_user);
    f.exits
        .recv_timeout(Duration::from_secs(5))
        .expect("stopped");
    // Closing again is harmless.
    assert!(f.service.close(&f.db, &info.id).expect("again").is_none());
}

#[test]
fn closing_a_tasks_terminals_and_shutting_down() {
    let f = fixture(Some(&fake_claude()));
    let t = f.task_with_folder();
    let a = f
        .service
        .open(&f.db, &f.input(&t, TerminalKind::Agent))
        .expect("claude");
    let mut sleeper = f.input(&t, TerminalKind::Command);
    sleeper.command = Some("sleep 300".into());
    f.service.open(&f.db, &sleeper).expect("sleep");
    let only_t = std::slice::from_ref(&t);
    assert_eq!(f.service.task_ids(), only_t);
    assert_eq!(f.service.close_for_tasks(&f.db, only_t), only_t);
    assert!(f.service.pty.list().is_empty());

    let b = f
        .service
        .open(&f.db, &f.input(&t, TerminalKind::Agent))
        .expect("claude 2");
    f.service.shutdown(&f.db);
    assert!(f.service.pty.list().is_empty());
    let states: Vec<String> = {
        let conn = f.db.lock().expect("lock");
        let mut stmt = conn
            .prepare("SELECT state FROM agent_sessions ORDER BY started_at, id")
            .expect("prepare");
        let rows = stmt.query_map([], |r| r.get(0)).expect("query");
        rows.collect::<Result<_, _>>().expect("rows")
    };
    assert_eq!(states.len(), 2);
    assert!(
        states.contains(&"paused".to_string()),
        "{states:?} ({:?} {:?})",
        a.id,
        b.id
    );
}

/// Review #2: a session whose terminal row is still open (a resume being
/// launched, unknown to the PTY manager yet) cannot be resumed a second time.
#[test]
fn a_session_being_launched_cannot_be_resumed_twice() {
    let f = fixture(Some(&fake_claude()));
    let t = f.task_with_folder();
    {
        let conn = f.db.lock().expect("lock");
        crate::db::test_support::claude_terminal(&conn, &t, "term-x", "s-x", "uuid-x");
        crate::db::journal::add_for_session(
            &conn,
            &t,
            "s-x",
            crate::model::JournalKind::Prompt,
            "bonjour",
        )
        .expect("prompt");
    }
    let again = f.service.resume(
        &f.db,
        &crate::model::ResumeSessionInput {
            agent_session_id: "s-x".into(),
            cols: 80,
            rows: 24,
        },
    );
    assert!(matches!(again, Err(AppError::Invalid(_))), "{again:?}");
    assert!(f.service.pty.list().is_empty());
}

#[test]
fn installed_agents_lists_only_the_binaries_found() {
    let f = fixture(None);
    let claude = f.work_dir.path().join("my-claude");
    std::fs::write(&claude, "#!/bin/sh\n").expect("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    set_claude_path(&f, &claude.to_string_lossy());
    settings::update(
        &f.db.lock().expect("lock"),
        &crate::model::SettingsPatch {
            codex_path: Some(crate::abs!("/nope/codex").into()),
            ..Default::default()
        },
    )
    .expect("settings");
    assert_eq!(
        f.service.installed_agents(&f.db).expect("installed"),
        vec![crate::model::Agent::Claude]
    );
    set_claude_path(&f, crate::abs!("/nope/claude"));
    assert!(f
        .service
        .installed_agents(&f.db)
        .expect("installed")
        .is_empty());
}
