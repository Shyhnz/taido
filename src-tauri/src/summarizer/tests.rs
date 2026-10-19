//! Recap tests with a fake `claude` script (never the real one).

use std::time::Instant;

use super::*;
use crate::db::journal::add_for_session;
use crate::db::terminals::{insert, mark_exited, NewSession, NewTerminal};
use crate::db::test_support::task;
use crate::model::{Exchange, JournalKind, SettingsPatch, TerminalKind};

fn exchange(kind: ExchangeKind, text: &str) -> Exchange {
    Exchange {
        kind,
        text: text.into(),
        at: "2026-10-03T10:00:00.000Z".into(),
    }
}

#[test]
fn the_conversation_keeps_messages_and_replies_only() {
    let text = conversation_text(
        crate::model::Agent::Claude,
        &[
            exchange(ExchangeKind::Prompt, "Crée test.txt"),
            exchange(ExchangeKind::Error, "rate_limit"),
            exchange(ExchangeKind::Reply, "C'est fait."),
            exchange(ExchangeKind::Cleared, ""),
        ],
    )
    .expect("text");
    assert_eq!(
        text,
        "<conversation>\nUtilisateur : Crée test.txt\nClaude : C'est fait.\n</conversation>\n"
    );
    assert_eq!(
        conversation_text(
            crate::model::Agent::Claude,
            &[exchange(ExchangeKind::Error, "x")]
        ),
        None
    );
    let long = vec![exchange(ExchangeKind::Prompt, &"é".repeat(5000)); 20];
    let text = conversation_text(crate::model::Agent::Claude, &long).expect("text");
    assert!(text.chars().count() <= CONVERSATION_MAX_CHARS + 40);
}

#[test]
fn the_recap_is_one_clean_line() {
    assert_eq!(
        clean("\n  « Création d'un fichier test.txt. »\nautre ligne").as_deref(),
        Some("Création d'un fichier test.txt")
    );
    assert_eq!(clean("   \n  "), None);
    assert_eq!(
        clean(&"a".repeat(300)).map(|s| s.chars().count()),
        Some(history::TITLE_MAX_CHARS)
    );
}

struct Rig {
    db: Arc<Mutex<Connection>>,
    done: Arc<Mutex<Vec<String>>>,
    summarizer: Summarizer,
    task_id: String,
    _dir: tempfile::TempDir,
}

/// A database with one ended session that has a message, and a summarizer whose `claude`
/// is `script` (a shell script body).
fn rig(script: &str) -> Rig {
    rig_for(crate::model::Agent::Claude, script)
}

/// Like [`rig`], the session run by `agent`, whose binary is `script`.
fn rig_for(agent: crate::model::Agent, script: &str) -> Rig {
    let dir = tempfile::tempdir().expect("tempdir");
    let bin = dir.path().join("claude");
    std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).expect("script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    let conn = crate::db::open_in_memory().expect("db");
    let task_id = task(&conn, "T", None, None);
    insert(
        &conn,
        &NewTerminal {
            id: "term-1",
            task_id: &task_id,
            kind: TerminalKind::Agent,
            command: None,
            cwd: "/tmp",
            opened_at: "2026-10-03T09:00:00.000Z",
        },
        Some(&NewSession {
            id: "s-1",
            task_id: &task_id,
            conversation_id: "uuid-1",
            agent,
            terminal_id: "term-1",
            permission_mode: None,
            add_task_context: true,
            at: "2026-10-03T09:00:00.000Z",
        }),
    )
    .expect("session");
    add_for_session(&conn, &task_id, "s-1", JournalKind::Prompt, "Crée test.txt").expect("p");
    add_for_session(
        &conn,
        &task_id,
        "s-1",
        JournalKind::TurnEnded,
        "C'est fait.",
    )
    .expect("r");
    mark_exited(&conn, "term-1", Some(0)).expect("ended");
    let db = Arc::new(Mutex::new(conn));
    let done = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&done);
    let mut env = BTreeMap::new();
    env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    let summarizer = Summarizer::start(Deps {
        db: Arc::clone(&db),
        agent: Arc::new(move |_, asked| (asked == agent).then(|| (bin.clone(), env.clone()))),
        on_done: Arc::new(move |task| seen.lock().expect("lock").push(task.to_string())),
        cwd: dir.path().join("cwd"),
    });
    Rig {
        db,
        done,
        summarizer,
        task_id,
        _dir: dir,
    }
}

fn ai_summary(r: &Rig) -> Option<String> {
    r.db.lock()
        .expect("lock")
        .query_row(
            "SELECT ai_summary FROM agent_sessions WHERE id = 's-1'",
            [],
            |row| row.get(0),
        )
        .expect("row")
}

fn wait(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn an_ended_session_gets_its_recap_once() {
    // The fake checks it got the print-mode flags and the conversation on stdin.
    let r = rig(
        r#"case "$*" in *"-p --model haiku --no-session-persistence --restricted"*) ;; *) exit 3 ;; esac
input=$(cat)
case "$input" in *"Utilisateur : Crée test.txt"*) echo "  Création de test.txt."; echo "bruit" ;; *) exit 4 ;; esac"#,
    );
    r.summarizer.request(Some(&r.task_id));
    wait("the recap", || ai_summary(&r).is_some());
    assert_eq!(ai_summary(&r).as_deref(), Some("Création de test.txt"));
    assert_eq!(
        r.done.lock().expect("lock").as_slice(),
        std::slice::from_ref(&r.task_id)
    );
    // Already summarized: nothing more to do.
    r.summarizer.request(None);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(r.done.lock().expect("lock").len(), 1);
    // The user's title is kept apart and wins in the UI.
    history::rename(&r.db.lock().expect("lock"), "s-1", "  Mon titre  ").expect("rename");
    let list = history::sessions_of_task(&r.db.lock().expect("lock"), &r.task_id, |_| false)
        .expect("list");
    assert_eq!(list[0].title.as_deref(), Some("Mon titre"));
    assert_eq!(list[0].ai_summary.as_deref(), Some("Création de test.txt"));
    history::rename(&r.db.lock().expect("lock"), "s-1", "").expect("clear");
    let list = history::sessions_of_task(&r.db.lock().expect("lock"), &r.task_id, |_| false)
        .expect("list");
    assert_eq!(list[0].title, None);
}

#[test]
fn a_failure_keeps_the_fallback_and_is_not_retried() {
    let r = rig("cat > /dev/null; exit 1");
    r.summarizer.request(Some(&r.task_id));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(ai_summary(&r), None);
    r.summarizer.request(Some(&r.task_id));
    std::thread::sleep(Duration::from_millis(300));
    assert!(r.done.lock().expect("lock").is_empty());
}

#[test]
fn nothing_runs_when_recaps_are_off() {
    let r = rig("echo 'Ne doit pas servir'");
    crate::db::settings::update(
        &r.db.lock().expect("lock"),
        &SettingsPatch {
            summarize_sessions: Some(false),
            ..Default::default()
        },
    )
    .expect("off");
    r.summarizer.request(Some(&r.task_id));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(ai_summary(&r), None);
}

#[test]
fn a_codex_session_is_summarized_by_codex() {
    let r = rig_for(
        crate::model::Agent::Codex,
        r#"case "$*" in "exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only"*" -") ;; *) exit 3 ;; esac
input=$(cat)
case "$input" in *"Codex : C'est fait."*) echo "Création de test.txt par Codex" ;; *) exit 4 ;; esac"#,
    );
    r.summarizer.request(Some(&r.task_id));
    wait("the recap", || ai_summary(&r).is_some());
    assert_eq!(
        ai_summary(&r).as_deref(),
        Some("Création de test.txt par Codex")
    );
}

#[test]
fn the_instruction_is_english_and_names_the_language_of_the_recap() {
    let en = system_prompt("Codex", Language::En);
    assert!(en.contains("a single sentence in English"), "{en}");
    let fr = system_prompt("Claude Code", Language::Fr);
    assert!(fr.contains("a single sentence in French"), "{fr}");
    assert!(fr.contains("Claude Code"));
}
