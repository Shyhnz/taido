use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::json;

use super::run::{Asks, Emit, Launch};
use super::*;
use crate::db::{journal, notes, open_in_memory, questions, tasks, test_support as ts};
use crate::model::{CreateNotePageInput, JournalKind, NoteKind, SetCompletedInput};

fn new_page(conn: &Connection, subject: &str, title: &str, body: &str) -> String {
    notes::create_page(
        conn,
        &CreateNotePageInput {
            subject_id: subject.into(),
            group_id: None,
            title: title.into(),
            body: body.into(),
            kind: NoteKind::Page,
            source_task_id: None,
        },
    )
    .expect("page")
    .id
}

fn done_task(conn: &Connection, subject: &str, title: &str, note: &str) -> String {
    let id = ts::task(conn, title, Some(subject), None);
    tasks::update(
        conn,
        &crate::model::UpdateTaskInput {
            id: id.clone(),
            title: None,
            description: Some(note.into()),
        },
    )
    .expect("note");
    tasks::set_completed(
        conn,
        &SetCompletedInput {
            id: id.clone(),
            completed: true,
        },
    )
    .expect("complete");
    id
}

/// A Claude session on `task` with one prompt and one reply.
fn conversation(conn: &Connection, task: &str, session: &str, prompt: &str, reply: &str) {
    ts::claude_terminal(
        conn,
        task,
        &format!("term-{session}"),
        session,
        &format!("conv-{session}"),
    );
    journal::add_for_session(conn, task, session, JournalKind::Prompt, prompt).expect("prompt");
    journal::add_for_session(conn, task, session, JournalKind::TurnEnded, reply).expect("reply");
}

struct Fixture {
    conn: Connection,
    scope: Scope,
    other: Scope,
    page: String,
    done: String,
    open: String,
    other_page: String,
    _dir: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let conn = open_in_memory().expect("db");
    let dir = tempfile::tempdir().expect("dir");
    std::fs::write(
        dir.path().join("plan.md"),
        "# Plan\nLe lancement pilote est le 12 mars.\n",
    )
    .expect("file");
    let p = ts::subject(&conn, "Taido");
    conn.execute(
        "UPDATE subjects SET root_path = ?1 WHERE id = ?2",
        [dir.path().to_string_lossy().as_ref(), p.as_str()],
    )
    .expect("root");
    let o = ts::subject(&conn, "Autre");
    let page = new_page(
        &conn,
        &p,
        "Tarifs",
        "**Livraison** : la livraison standard prend 9 jours.\n\nPilote : lancement le 12 mars pour les 100 premiers.",
    );
    let done = done_task(
        &conn,
        &p,
        "Écran des réglages",
        "Fait le 11 octobre, écran fictif.",
    );
    let open = ts::task(&conn, "Traduire les réglages", Some(&p), None);
    let other_page = new_page(&conn, &o, "Prix secrets", "Le prix pilote est ailleurs.");
    conversation(
        &conn,
        &open,
        "s1",
        "Quel prix pour le pilote ?",
        "On garde le lancement du 12 mars pour les pilotes.",
    );
    let scope = super::scope(&conn, &p).expect("scope");
    let other = super::scope(&conn, &o).expect("scope");
    Fixture {
        conn,
        scope,
        other,
        page,
        done,
        open,
        other_page,
        _dir: dir,
    }
}

fn raw(kind: &str, reference: &str, quote: &str) -> RawSource {
    RawSource {
        kind: kind.into(),
        reference: reference.into(),
        quote: quote.into(),
    }
}

#[test]
fn scope_has_the_folder_when_it_exists() {
    let f = fixture();
    assert!(f.scope.root.is_some());
    assert_eq!(f.scope.subjects, vec![f.scope.subject_id.clone()]);
    // `/tmp/Autre` does not exist.
    assert!(f.other.root.is_none());
}

#[test]
fn search_project_finds_pages_and_completed_tasks_only() {
    let f = fixture();
    let hits = search::search_project(&f.conn, &f.scope, "pilote").expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, f.page);
    assert!(hits[0].excerpt.contains("100 premiers"), "{:?}", hits[0]);
    // Accents and case ignored, title counts.
    let hits = search::search_project(&f.conn, &f.scope, "ECRAN").expect("search");
    assert_eq!(
        hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
        [f.done.as_str()]
    );
    // The open task is not offered.
    let hits = search::search_project(&f.conn, &f.scope, "traduire").expect("search");
    assert!(hits.is_empty());
    // The other project's page is not either.
    let hits = search::search_project(&f.conn, &f.scope, "secrets").expect("search");
    assert!(hits.is_empty());
}

#[test]
fn search_conversations_finds_sessions_and_questions() {
    let f = fixture();
    let hits = search::search_conversations(&f.conn, &f.scope, "pilotes").expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "s1");
    assert!(hits[0].excerpt.starts_with("Claude : "), "{:?}", hits[0]);
    let q = questions::insert(
        &f.conn,
        &f.scope.subject_id,
        "t1",
        Agent::Claude,
        "Et la traduction ?",
        "Prévue en espagnol.",
        &[],
    )
    .expect("question");
    let hits = search::search_conversations(&f.conn, &f.scope, "espagnol").expect("search");
    assert_eq!(hits[0].id, q.id);
    assert!(search::search_conversations(&f.conn, &f.other, "espagnol")
        .expect("search")
        .is_empty());
}

#[test]
fn sources_are_checked() {
    let f = fixture();
    let check = |r: RawSource| verify::check(&f.conn, &f.scope, &r).expect("check");
    // Markdown, punctuation and case do not count.
    let s = check(raw("page", &f.page, "la livraison standard prend 9 jours"));
    assert!(s.found);
    assert_eq!(s.label, "Tarifs");
    // A changed word does.
    assert!(!check(raw("page", &f.page, "la livraison express prend 3 jours")).found);
    // Another project's page is not found.
    let s = check(raw("page", &f.other_page, "Le prix pilote est ailleurs"));
    assert!(!s.found);
    assert_eq!(s.label, f.other_page);
    // A task, any state, title or note.
    let s = check(raw("task", &f.done, "écran fictif"));
    assert!(s.found && s.at.is_some() && s.task_id.as_deref() == Some(f.done.as_str()));
    assert!(check(raw("task", &f.open, "Traduire les réglages")).found);
    // A conversation opens its task.
    let s = check(raw(
        "conversation",
        "s1",
        "On garde le lancement du 12 mars",
    ));
    assert!(s.found);
    assert_eq!(s.task_id.as_deref(), Some(f.open.as_str()));
    // A file inside the folder, its path made relative.
    let root = f.scope.root.clone().expect("root");
    let abs = root.join("plan.md").to_string_lossy().into_owned();
    let s = check(raw("file", &abs, "lancement pilote est le 12 mars"));
    assert!(s.found);
    assert_eq!(s.reference, "plan.md");
    // Too short to prove anything.
    assert!(!check(raw("page", &f.page, "Prix")).found);
    // Unknown kind.
    assert!(!check(raw("site", &f.page, "la livraison standard prend 9 jours")).found);
    // A deleted page.
    notes::delete_page(&f.conn, &f.page).expect("delete");
    assert!(!check(raw("page", &f.page, "la livraison standard prend 9 jours")).found);
}

#[test]
fn files_outside_the_folder_are_refused() {
    let f = fixture();
    let root = f.scope.root.clone().expect("root");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(
        outside.path().join("secret.txt"),
        "le mot de passe est caché ici",
    )
    .expect("secret");
    let rel = format!(
        "../{}/secret.txt",
        outside.path().file_name().expect("name").to_string_lossy()
    );
    // Both temp dirs share a parent: `..` reaches the other one.
    assert!(verify::read_inside(&root, &rel).is_none());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("lien.txt"))
            .expect("link");
        assert!(verify::read_inside(&root, "lien.txt").is_none());
    }
    std::fs::write(root.join("binaire.bin"), [0u8, 1, 2, 3]).expect("bin");
    assert!(verify::read_inside(&root, "binaire.bin").is_none());
    assert!(verify::read_inside(&root, "plan.md").is_some());
}

#[test]
fn duplicate_sources_are_kept_once() {
    let f = fixture();
    let sources = verify::check_all(
        &f.conn,
        &f.scope,
        &[
            raw("page", &f.page, "inventé de toutes pièces"),
            raw("page", &f.page, "la livraison standard prend 9 jours"),
            raw("task", &f.done, "écran fictif"),
        ],
    )
    .expect("check");
    assert_eq!(sources.len(), 2);
    assert!(sources.iter().all(|s| s.found));
}

#[test]
fn tools_read_only_their_project() {
    let f = fixture();
    let (r, step) = tools::run(
        &f.conn,
        &f.scope,
        "read_note_page",
        &json!({ "id": f.page }),
    );
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("100 premiers"));
    assert_eq!(
        step,
        Some(AskStep::ReadPage {
            title: "Tarifs".into()
        })
    );
    let (r, _) = tools::run(
        &f.conn,
        &f.scope,
        "read_note_page",
        &json!({ "id": f.other_page }),
    );
    assert!(r.is_error);
    let (r, _) = tools::run(&f.conn, &f.scope, "read_task", &json!({ "id": f.done }));
    assert!(r.text.contains("écran fictif"), "{}", r.text);
    let (r, step) = tools::run(
        &f.conn,
        &f.scope,
        "read_conversation",
        &json!({ "id": "s1" }),
    );
    assert!(r.text.contains("Utilisateur : Quel prix"), "{}", r.text);
    assert!(matches!(step, Some(AskStep::ReadConversation { .. })));
    let (r, _) = tools::run(
        &f.conn,
        &f.other,
        "read_conversation",
        &json!({ "id": "s1" }),
    );
    assert!(r.is_error);
    let (r, step) = tools::run(
        &f.conn,
        &f.scope,
        "search_project",
        &json!({ "query": "pilote" }),
    );
    assert!(r.text.contains(&f.page));
    assert_eq!(
        step,
        Some(AskStep::SearchNotes {
            query: "pilote".into()
        })
    );
    // Writing tools do not exist here.
    let (r, _) = tools::run(&f.conn, &f.scope, "create_task", &json!({ "title": "x" }));
    assert!(r.is_error);
    let names: Vec<String> = tools::definitions()
        .as_array()
        .expect("list")
        .iter()
        .map(|d| d["name"].as_str().expect("name").to_string())
        .collect();
    assert_eq!(names, tools::TOOL_NAMES);
}

#[test]
fn store_checks_and_keeps_the_answer() {
    let f = fixture();
    let answer = RawAnswer {
        answer: "Le 12 mars, pour les 100 premiers.".into(),
        sources: vec![
            raw(
                "page",
                &f.page,
                "lancement le 12 mars pour les 100 premiers",
            ),
            raw("task", "inconnue", "rien du tout ici"),
        ],
    };
    let entry = store(&f.conn, &f.scope, "t1", Agent::Codex, "Le prix ?", &answer)
        .expect("store")
        .expect("entry");
    assert_eq!(entry.sources.len(), 2);
    assert!(entry.sources[0].found && !entry.sources[1].found);
    assert_eq!(
        questions::thread(&f.conn, "t1").expect("thread"),
        vec![entry.clone()]
    );
    let threads = questions::threads(&f.conn, &f.scope.subject_id).expect("threads");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].question, "Le prix ?");
    let md = as_markdown(&entry);
    assert!(md.contains(&format!("[[page:{}|Tarifs]]", f.page)), "{md}");
    assert!(!md.contains("inconnue"));
    // An empty answer is none.
    let empty = RawAnswer {
        answer: " ".into(),
        sources: vec![],
    };
    assert!(store(&f.conn, &f.scope, "t1", Agent::Claude, "?", &empty)
        .expect("store")
        .is_none());
}

#[test]
fn follow_up_questions_carry_the_previous_exchanges() {
    let entry = |q: &str| AskEntry {
        id: q.into(),
        thread_id: "t".into(),
        agent: Agent::Claude,
        question: q.into(),
        answer: format!("réponse {q}"),
        sources: vec![],
        asked_at: String::new(),
    };
    assert_eq!(user_message(&[], "Quoi ?"), "Question : Quoi ?");
    let history: Vec<AskEntry> = (0..7).map(|i| entry(&format!("q{i}"))).collect();
    let m = user_message(&history, "Et ensuite ?");
    assert!(
        !m.contains("q1") && m.contains("q2") && m.contains("réponse q6"),
        "{m}"
    );
    assert!(m.ends_with("Question : Et ensuite ?"));
}

#[test]
fn launch_arguments() {
    let f = fixture();
    let system = system_prompt(&f.scope);
    assert!(system.contains("« Taido »") && system.contains("dossier du projet"));
    assert!(!system_prompt(&f.other).contains("dossier du projet"));
    let args = claude_args(&system, Path::new("/d/ask-mcp.json"));
    for flag in [
        "-p",
        "--restricted",
        "--no-session-persistence",
        "--strict-mcp-config",
    ] {
        assert!(args.iter().any(|a| a == flag), "{flag}");
    }
    assert!(args.iter().any(|a| a == "mcp__taido__search_conversations"));
    assert!(!args.iter().any(|a| a.contains("Bash")));
    let args = codex_args(&system, 4242, Path::new("/p"), Path::new("/d/s.json"));
    assert!(args.windows(2).any(|w| w[0] == "-s" && w[1] == "read-only"));
    assert!(args
        .iter()
        .any(|a| a.contains("http://127.0.0.1:4242/mcp/ask")));
    assert_eq!(args.last().map(String::as_str), Some("-"));
    let mcp = mcp_config(4242);
    assert_eq!(
        mcp["mcpServers"]["taido"]["headers"]["X-Ask-Id"],
        "${TAIDO_ASK_ID}"
    );
}

/// A stand-in agent: a shell script that prints the recorded Claude run.
#[cfg(unix)]
fn fake_agent(dir: &Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("agent.sh");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

#[cfg(unix)]
fn launch(f: &Fixture, program: std::path::PathBuf, timeout: Duration) -> Launch {
    Launch {
        ask_id: "a1".into(),
        thread_id: "t1".into(),
        question: "Le prix ?".into(),
        agent: Agent::Claude,
        program,
        args: vec![],
        env: Default::default(),
        cwd: f.scope.root.clone().expect("root"),
        input: "Question : Le prix ?".into(),
        scope: Arc::new(f.scope.clone()),
        timeout,
    }
}

#[cfg(unix)]
fn collect(
    asks: &Arc<Asks>,
    l: Launch,
    db: Arc<Mutex<Connection>>,
) -> std::sync::mpsc::Receiver<AskUpdate> {
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Mutex::new(tx);
    let emit: Emit = Arc::new(move |u| {
        let _ = tx.lock().expect("tx").send(u);
    });
    asks.start(l, db, emit).expect("start");
    rx
}

#[cfg(unix)]
fn last(rx: &std::sync::mpsc::Receiver<AskUpdate>) -> (Vec<AskUpdate>, AskUpdate) {
    let mut seen = Vec::new();
    loop {
        let u = rx.recv_timeout(Duration::from_secs(20)).expect("update");
        match u {
            AskUpdate::Step { .. } => seen.push(u),
            other => return (seen, other),
        }
    }
}

#[cfg(unix)]
#[test]
fn a_run_streams_steps_then_stores_the_answer() {
    let f = fixture();
    let page = f.page.clone();
    let fixture_file = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/ask/claude-stream.jsonl"
    );
    let tool = format!(
        "{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{{\"file_path\":\"{}\"}}}}]}}}}",
        f.scope.root.clone().expect("root").join("plan.md").display()
    );
    let result = json!({
        "type": "result", "subtype": "success", "is_error": false,
        "structured_output": {
            "answer": "Le 12 mars.",
            "sources": [{ "kind": "page", "ref": page, "quote": "lancement le 12 mars pour les 100 premiers" }]
        }
    });
    let dir = tempfile::tempdir().expect("dir");
    let script = fake_agent(
        dir.path(),
        &format!(
            "cat > /dev/null\nhead -n 7 '{fixture_file}'\necho '{tool}'\necho '{}'",
            result.to_string().replace('\'', "'\\''")
        ),
    );
    let asks = Arc::new(Asks::default());
    let l = launch(&f, script, Duration::from_secs(20));
    let subject = f.scope.subject_id.clone();
    let db = Arc::new(Mutex::new(f.conn));
    let rx = collect(&asks, l, db.clone());
    assert!(asks.busy(&subject));
    let (steps, end) = last(&rx);
    assert!(
        steps.contains(&AskUpdate::Step {
            step: AskStep::ReadFile {
                path: "plan.md".into()
            }
        }),
        "{steps:?}"
    );
    let AskUpdate::Answer { entry } = end else {
        panic!("{end:?}")
    };
    assert_eq!(entry.answer, "Le 12 mars.");
    assert!(entry.sources[0].found);
    assert_eq!(
        questions::thread(&db.lock().expect("db"), "t1")
            .expect("thread")
            .len(),
        1
    );
    // Finished: the project is free again (the registry entry goes before the last update).
    assert!(!asks.busy(&subject));
}

#[cfg(unix)]
#[test]
fn a_run_can_be_stopped_or_time_out() {
    let f = fixture();
    let dir = tempfile::tempdir().expect("dir");
    let script = fake_agent(dir.path(), "cat > /dev/null\nsleep 30");
    let asks = Arc::new(Asks::default());
    let db = Arc::new(Mutex::new(open_in_memory().expect("db")));
    let rx = collect(
        &asks,
        launch(&f, script.clone(), Duration::from_secs(20)),
        db.clone(),
    );
    // A second question about the same project waits.
    let again = asks.start(
        launch(&f, script.clone(), Duration::from_secs(20)),
        db.clone(),
        Arc::new(|_| {}),
    );
    assert!(again.is_err());
    std::thread::sleep(Duration::from_millis(200));
    asks.stop("a1");
    assert_eq!(last(&rx).1, AskUpdate::Stopped);
    let rx = collect(&asks, launch(&f, script, Duration::from_millis(300)), db);
    assert_eq!(
        last(&rx).1,
        AskUpdate::Failed {
            message: None,
            timed_out: true
        }
    );
}

/// Spike with the real agent (never in `pnpm check`): `TAIDO_SPIKE_AGENT=claude|codex cargo
/// test --lib real_agent_spike -- --ignored --nocapture`. A tiny question on a one-page project
/// through the real hook server: the MCP tools, the header `X-Ask-Id` and the checked answer.
#[cfg(unix)]
#[test]
#[ignore]
fn real_agent_spike() {
    let agent = match std::env::var("TAIDO_SPIKE_AGENT").as_deref() {
        Ok("codex") => Agent::Codex,
        _ => Agent::Claude,
    };
    let f = fixture();
    let subject = f.scope.subject_id.clone();
    let scope = Arc::new(f.scope.clone());
    let db = Arc::new(Mutex::new(f.conn));
    let asks = Arc::new(Asks::default());
    let server = crate::hooks::HookServer::bind().expect("bind");
    let (port, token) = (server.port, server.token.clone());
    let (tools_db, tools_asks) = (db.clone(), asks.clone());
    let ask_tools: crate::mcp::ToolRunner = Arc::new(move |ask_id, name, args| {
        let Some((scope, emit)) = ask_id.and_then(|id| tools_asks.get(id)) else {
            return crate::mcp::ToolResult::error("no question");
        };
        let (r, step) = tools::run(&tools_db.lock().expect("db"), &scope, name, args);
        if let Some(step) = step {
            emit(AskUpdate::Step { step });
        }
        r
    });
    let none: crate::mcp::ToolRunner = Arc::new(|_, _, _| crate::mcp::ToolResult::error("no"));
    crate::hooks::test_serve_all(server, Arc::new(|_, _, _| {}), none, ask_tools);
    let data = tempfile::tempdir().expect("data");
    let mcp_file = data.path().join(MCP_FILE);
    std::fs::write(&mcp_file, mcp_config(port).to_string()).expect("mcp");
    let schema_file = data.path().join(SCHEMA_FILE);
    std::fs::write(&schema_file, answer_schema().to_string()).expect("schema");
    let env = crate::env::resolve();
    let bin = match agent {
        Agent::Claude => crate::agents::claude::resolve_binary(None, None, &env.vars),
        Agent::Codex => {
            crate::agents::resolve_binary(&crate::agents::codex::BINARY, None, None, &env.vars)
        }
    }
    .expect("agent binary");
    let mut vars = env.vars.clone();
    vars.insert("TAIDO_HOOK_TOKEN".into(), token);
    vars.insert(ASK_ID_VAR.into(), "spike".into());
    let cwd = scope.root.clone().expect("root");
    let system = system_prompt(&scope);
    let args = match agent {
        Agent::Claude => claude_args(&system, &mcp_file),
        Agent::Codex => codex_args(&system, port, &cwd, &schema_file),
    };
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Mutex::new(tx);
    asks.start(
        Launch {
            ask_id: "spike".into(),
            thread_id: "spike".into(),
            question: "Quel est le prix pilote ? Réponds en une phrase.".into(),
            agent,
            program: bin,
            args,
            env: vars,
            cwd,
            input: user_message(&[], "Quel est le prix pilote ? Réponds en une phrase."),
            scope,
            timeout: Duration::from_secs(170),
        },
        db,
        Arc::new(move |u| {
            let _ = tx.lock().expect("tx").send(u);
        }),
    )
    .expect("start");
    loop {
        let u = rx.recv_timeout(Duration::from_secs(180)).expect("update");
        println!("{u:?}");
        if !matches!(u, AskUpdate::Step { .. }) {
            assert!(matches!(u, AskUpdate::Answer { .. }), "{u:?} ({subject})");
            break;
        }
    }
}

fn plain_scope(root: Option<std::path::PathBuf>) -> Scope {
    Scope {
        subject_id: "s1".into(),
        name: "Taido".into(),
        subjects: vec!["s1".into()],
        root,
    }
}

#[test]
fn project_terminal_keys_are_not_task_ids() {
    let key = terminal::task_key("s1");
    assert_eq!(terminal::subject_of(&key), Some("s1"));
    assert_eq!(terminal::subject_of("01HTASK"), None);
}

#[test]
fn project_terminal_args_allow_only_the_project_tools() {
    let args = terminal::claude_args("consigne", Path::new("/data/ask-mcp.json"), "Nom");
    assert_eq!(
        &args[..3],
        ["--mcp-config", "/data/ask-mcp.json", "--allowedTools"]
    );
    let tools: Vec<&String> = args.iter().filter(|a| a.starts_with("mcp__")).collect();
    assert_eq!(tools.len(), tools::TOOL_NAMES.len());
    // Variadic options are each followed by another option, never by the prompt.
    let after = args
        .iter()
        .position(|a| a == "--append-system-prompt")
        .expect("prompt");
    assert_eq!(args[after - 1], "mcp__taido__read_conversation");
    assert_eq!(args[after + 1], "consigne");
    assert_eq!(args[args.len() - 2..], ["--name", "Nom"]);
    assert!(!args.iter().any(|a| a == "-p" || a == "--settings"));
}

#[test]
fn project_terminal_prompt_names_the_project_and_its_folder() {
    let without = terminal::system_prompt(&plain_scope(None));
    assert!(without.contains("« Taido »"));
    assert!(!without.contains("dossier du projet"));
    let with = terminal::system_prompt(&plain_scope(Some("/tmp".into())));
    assert!(with.contains("dossier du projet"));
}

#[test]
fn project_terminal_tools_answer_until_it_is_forgotten() {
    let asks = Asks::default();
    assert!(asks.get("term1").is_none());
    asks.add_terminal("term1", Arc::new(plain_scope(None)));
    let (scope, emit) = asks.get("term1").expect("registered");
    assert_eq!(scope.subject_id, "s1");
    emit(AskUpdate::Stopped); // goes nowhere
    assert!(!asks.busy("s1"), "a terminal is not a running question");
    asks.forget_terminal("term1");
    assert!(asks.get("term1").is_none());
}

#[test]
fn ask_opens_without_plan() {
    // A fresh database, no account: a project's scope is built, nothing asks for a plan.
    let conn = open_in_memory().expect("db");
    let p = ts::subject(&conn, "Free");
    let scope = super::scope(&conn, &p).expect("scope without any plan");
    assert_eq!(scope.subject_id, p);
}
