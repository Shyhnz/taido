//! One row per line of the state table.
//!
//! Out of scope, not tested here: Autoriser / Refuser, « Ignorer »
//! on a crash, sessions found live at startup (`db::terminals::close_orphans`,
//! ), the conversation change itself.

use serde_json::json;

use super::*;
use crate::model::SessionState::{Crashed, Done, Error, Idle, Paused, Starting, Waiting, Working};
use crate::model::WaitingKind::{Input, Permission, Question};

const SID: &str = "f91558df-7993-4183-badd-bbeeeef25427";
const BEFORE: &str = "2026-10-03T10:00:00.000Z";
const NOW: &str = "2026-10-03T10:05:00.000Z";

fn session(state: SessionState, kind: Option<WaitingKind>) -> Session {
    Session {
        state,
        waiting_kind: kind,
        state_changed_at: BEFORE.into(),
        ..Session::starting(SID, BEFORE)
    }
}

fn with_pending(mut s: Session) -> Session {
    s.pending_permission = Some(PendingPermission {
        tool_name: "Bash".into(),
        summary: "Commande : rm -rf dist".into(),
        tool_input: bash("rm -rf dist"),
    });
    s
}

fn bash(command: &str) -> Value {
    json!({ "command": command, "description": "test" })
}

fn post(tool_name: &str, tool_input: Value) -> Event {
    Event::PostToolUse {
        tool_name: tool_name.into(),
        tool_input,
        cwd: some("/w"),
    }
}

fn post_failure(tool_name: &str, tool_input: Value) -> Event {
    Event::PostToolUseFailure {
        tool_name: tool_name.into(),
        tool_input,
        cwd: some("/w"),
    }
}

/// A 600-character turn that ends with a question.
fn long_question() -> String {
    format!(
        "{}\n\nTu veux que je pousse la branche ?",
        "J'ai refait l'export CSV et ajouté les tests. ".repeat(13)
    )
}

fn some(s: &str) -> Option<String> {
    Some(s.to_string())
}

struct Row {
    /// The state-table line (current state | event).
    line: &'static str,
    from: Session,
    event: Event,
    to: (SessionState, Option<WaitingKind>),
    effects: Vec<Effect>,
    /// Extra checks on the next session.
    check: fn(&Session),
}

fn none(_: &Session) {}

fn rows() -> Vec<Row> {
    vec![
        Row {
            line: "— | lancement du processus → Starting, ended_cleanly = 0",
            from: Session {
                ended_cleanly: true,
                error_kind: some("rate_limit"),
                activity: some("Lecture a.rs"),
                ..with_pending(session(Paused, None))
            },
            event: Event::Launched,
            to: (Starting, None),
            effects: vec![],
            check: |s| {
                assert!(!s.ended_cleanly);
                assert_eq!(s.pending_permission, None);
                assert_eq!(s.activity, None);
                assert_eq!(s.error_kind, None);
            },
        },
        Row {
            line: "Starting depuis plus de 8 s sans SessionStart | minuteur → Waiting(Input)",
            from: session(Starting, None),
            event: Event::StartingTimeout,
            to: (Waiting, Some(Input)),
            effects: vec![Effect::Notify],
            check: none,
        },
        Row {
            line: "Starting | minuteur après un SessionStart (déjà Idle) → inchangé",
            from: session(Idle, None),
            event: Event::StartingTimeout,
            to: (Idle, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "Starting | SessionStart(startup) avec le session_id attendu → Idle",
            from: session(Starting, None),
            event: Event::SessionStart {
                session_id: some(SID),
                source: some("startup"),
            },
            to: (Idle, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "Waiting(Input) | SessionStart(resume) avec le session_id attendu → Idle",
            from: session(Waiting, Some(Input)),
            event: Event::SessionStart {
                session_id: some(SID),
                source: some("resume"),
            },
            to: (Idle, None),
            effects: vec![Effect::Log("conversation resumed".into())],
            check: none,
        },
        Row {
            line: "tout état vivant | SessionStart d'un autre session_id → inchangé (pas encore géré)",
            from: session(Working, None),
            event: Event::SessionStart {
                session_id: some("8b722854-a341-495c-af8c-b3b2118a26ed"),
                source: some("clear"),
            },
            to: (Working, None),
            effects: vec![Effect::Log(
                "conversation change to 8b722854-a341-495c-af8c-b3b2118a26ed (source clear) \
                 not handled yet"
                    .into(),
            )],
            check: none,
        },
        Row {
            line: "tout état vivant | SessionStart(compact) → inchangé",
            from: session(Done, None),
            event: Event::SessionStart {
                session_id: some(SID),
                source: some("compact"),
            },
            to: (Done, None),
            effects: vec![Effect::Log("context compacted".into())],
            check: none,
        },
        Row {
            line: "tout état vivant | UserPromptSubmit → Working, activité vidée, file vidée",
            from: Session {
                activity: some("Commande : ls"),
                ..with_pending(session(Waiting, Some(Permission)))
            },
            event: Event::UserPromptSubmit,
            to: (Working, None),
            effects: vec![Effect::ReleasePermissions],
            check: |s| {
                assert_eq!(s.activity, None);
                assert_eq!(s.pending_permission, None);
            },
        },
        Row {
            line: "tout état vivant | PreToolUse → Working, activité = résumé de l'outil",
            from: session(Idle, None),
            event: Event::PreToolUse {
                tool_name: "Bash".into(),
                tool_input: bash("npm test"),
                cwd: None,
            },
            to: (Working, None),
            effects: vec![],
            check: |s| assert_eq!(s.activity.as_deref(), Some("Commande : npm test")),
        },
        Row {
            line: "Waiting(Permission), file non vide | PreToolUse → reste Waiting(Permission)",
            from: with_pending(session(Waiting, Some(Permission))),
            event: Event::PreToolUse {
                tool_name: "Read".into(),
                tool_input: json!({ "file_path": "/w/src/a.rs" }),
                cwd: some("/w"),
            },
            to: (Waiting, Some(Permission)),
            effects: vec![],
            check: |s| {
                assert_eq!(s.activity.as_deref(), Some("Lecture src/a.rs"));
                assert!(s.pending_permission.is_some());
            },
        },
        Row {
            line: "tout état vivant | PostToolUse → Working (réponse donnée dans le terminal)",
            from: with_pending(session(Waiting, Some(Permission))),
            event: post("Bash", bash("rm -rf dist")),
            to: (Working, None),
            effects: vec![Effect::ReleasePermissions],
            check: |s| assert_eq!(s.pending_permission, None),
        },
        Row {
            line: "tout état vivant | PostToolUseFailure de l'outil demandé → Working",
            from: with_pending(session(Waiting, Some(Permission))),
            event: post_failure("Bash", bash("rm -rf dist")),
            to: (Working, None),
            effects: vec![Effect::ReleasePermissions],
            check: |s| assert_eq!(s.pending_permission, None),
        },
        Row {
            line: "tout état vivant | PostToolUse d'un autre outil, file non vide → reste Waiting(Permission) (8.5 point 6)",
            from: with_pending(session(Waiting, Some(Permission))),
            event: post("Read", json!({ "file_path": "/w/src/a.rs" })),
            to: (Waiting, Some(Permission)),
            effects: vec![],
            check: |s| {
                assert!(s.pending_permission.is_some());
                assert_eq!(s.state_changed_at, BEFORE);
            },
        },
        Row {
            line: "tout état vivant | PostToolUse du même outil avec une autre commande → reste Waiting(Permission)",
            from: with_pending(session(Waiting, Some(Permission))),
            event: post_failure("Bash", bash("ls")),
            to: (Waiting, Some(Permission)),
            effects: vec![],
            check: |s| assert!(s.pending_permission.is_some()),
        },
        Row {
            line: "tout état vivant | PostToolUseFailure → Working",
            from: session(Waiting, Some(Input)),
            event: post_failure("Grep", json!({ "pattern": "x" })),
            to: (Working, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "tout état vivant | PermissionRequest → Waiting(Permission), ajoute à la file",
            from: session(Working, None),
            event: Event::PermissionRequest {
                tool_name: "Bash".into(),
                tool_input: bash("touch spike-1.txt"),
                cwd: None,
            },
            to: (Waiting, Some(Permission)),
            effects: vec![Effect::Notify],
            check: |s| {
                let p = s.pending_permission.as_ref().expect("pending");
                assert_eq!(p.tool_name, "Bash");
                assert_eq!(p.summary, "Commande : touch spike-1.txt");
            },
        },
        Row {
            line: "Waiting(Permission) | second PermissionRequest → la première reste affichée",
            from: with_pending(session(Waiting, Some(Permission))),
            event: Event::PermissionRequest {
                tool_name: "Write".into(),
                tool_input: json!({ "file_path": "/w/b.txt" }),
                cwd: some("/w"),
            },
            to: (Waiting, Some(Permission)),
            effects: vec![],
            check: |s| {
                let p = s.pending_permission.as_ref().expect("pending");
                assert_eq!(p.summary, "Commande : rm -rf dist");
            },
        },
        Row {
            line: "Working | Notification(permission_prompt) → Waiting(Permission)",
            from: session(Working, None),
            event: Event::Notification {
                notification_type: some("permission_prompt"),
            },
            to: (Waiting, Some(Permission)),
            effects: vec![Effect::Notify],
            check: |s| assert_eq!(s.pending_permission, None),
        },
        Row {
            line: "Done | Notification(permission_prompt) → inchangé (filet seulement en Working)",
            from: session(Done, None),
            event: Event::Notification {
                notification_type: some("permission_prompt"),
            },
            to: (Done, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "tout état vivant | Notification(elicitation_dialog…) → Waiting(Input)",
            from: session(Working, None),
            event: Event::Notification {
                notification_type: some("elicitation_dialog"),
            },
            to: (Waiting, Some(Input)),
            effects: vec![Effect::Notify],
            check: none,
        },
        Row {
            line: "tout état vivant | Notification(agent_needs_input) → Waiting(Input)",
            from: session(Idle, None),
            event: Event::Notification {
                notification_type: some("agent_needs_input"),
            },
            to: (Waiting, Some(Input)),
            effects: vec![Effect::Notify],
            check: none,
        },
        Row {
            line: "tout | Notification(idle_prompt) → inchangé",
            from: session(Done, None),
            event: Event::Notification {
                notification_type: some("idle_prompt"),
            },
            to: (Done, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "tout | Notification(auth_success) → inchangé",
            from: session(Starting, None),
            event: Event::Notification {
                notification_type: some("auth_success"),
            },
            to: (Starting, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "tout état vivant | Stop → Done, last_message",
            from: Session {
                activity: some("Commande : ls"),
                ..session(Working, None)
            },
            event: Event::Stop {
                last_assistant_message: some("OK"),
            },
            to: (Done, None),
            effects: vec![Effect::Notify],
            check: |s| assert_eq!(s.last_message.as_deref(), Some("OK")),
        },
        Row {
            line: "tout état vivant | Stop finissant par « ? » → Waiting(Question), file vidée",
            from: with_pending(session(Waiting, Some(Permission))),
            event: Event::Stop {
                last_assistant_message: some("Tu veux un café ?"),
            },
            to: (Waiting, Some(Question)),
            effects: vec![Effect::ReleasePermissions, Effect::Notify],
            check: |s| {
                assert_eq!(s.last_message.as_deref(), Some("Tu veux un café ?"));
                assert_eq!(s.question.as_deref(), Some("Tu veux un café ?"));
                assert_eq!(s.pending_permission, None);
            },
        },
        Row {
            line: "tout état vivant | Stop de plus de 500 caractères finissant par « ? » → Waiting(Question), question gardée",
            from: session(Working, None),
            event: Event::Stop {
                last_assistant_message: Some(long_question()),
            },
            to: (Waiting, Some(Question)),
            effects: vec![Effect::Notify],
            check: |s| {
                let m = s.last_message.as_deref().expect("message");
                assert!(m.ends_with('…'), "stored message is cut: {m}");
                assert_eq!(
                    s.question.as_deref(),
                    Some("Tu veux que je pousse la branche ?")
                );
            },
        },
        Row {
            line: "Waiting(Question) | UserPromptSubmit → Working, question effacée",
            from: Session {
                question: some("On pousse ?"),
                ..session(Waiting, Some(Question))
            },
            event: Event::UserPromptSubmit,
            to: (Working, None),
            effects: vec![],
            check: |s| assert_eq!(s.question, None),
        },
        Row {
            line: "tout état vivant | Stop → last_message tronqué à 500 caractères",
            from: session(Working, None),
            event: Event::Stop {
                last_assistant_message: Some("x".repeat(800)),
            },
            to: (Done, None),
            effects: vec![Effect::Notify],
            check: |s| {
                let m = s.last_message.as_deref().expect("message");
                assert_eq!(m.chars().count(), summary::LAST_MESSAGE_MAX);
            },
        },
        Row {
            line: "tout état vivant | StopFailure(rate_limit) → Error, notification",
            from: session(Working, None),
            event: Event::StopFailure {
                error: some("rate_limit"),
            },
            to: (Error, None),
            effects: vec![Effect::Notify],
            check: |s| assert_eq!(s.error_kind.as_deref(), Some("rate_limit")),
        },
        Row {
            line: "tout état vivant | StopFailure(overloaded) → Error, pas de notification",
            from: session(Working, None),
            event: Event::StopFailure {
                error: some("overloaded"),
            },
            to: (Error, None),
            effects: vec![],
            check: |s| assert_eq!(s.error_kind.as_deref(), Some("overloaded")),
        },
        Row {
            line: "Error | UserPromptSubmit → Working, erreur effacée",
            from: Session {
                error_kind: some("overloaded"),
                ..session(Error, None)
            },
            event: Event::UserPromptSubmit,
            to: (Working, None),
            effects: vec![],
            check: |s| assert_eq!(s.error_kind, None),
        },
        Row {
            line: "tout état vivant | Interrompre → Idle, file vidée",
            from: with_pending(session(Waiting, Some(Permission))),
            event: Event::Interrupt,
            to: (Idle, None),
            effects: vec![Effect::ReleasePermissions],
            check: |s| assert_eq!(s.pending_permission, None),
        },
        Row {
            line: "tout | SessionEnd → inchangé, ended_cleanly = 1",
            from: session(Done, None),
            event: Event::SessionEnd {
                reason: some("prompt_input_exit"),
            },
            to: (Done, None),
            effects: vec![],
            check: |s| assert!(s.ended_cleanly),
        },
        Row {
            line: "tout | SessionEnd(clear) → inchangé, un SessionStart(clear) va suivre",
            from: session(Idle, None),
            event: Event::SessionEnd {
                reason: some("clear"),
            },
            to: (Idle, None),
            effects: vec![Effect::Log(
                "conversation cleared, a new conversation follows".into(),
            )],
            check: |s| assert!(s.ended_cleanly),
        },
        Row {
            line: "tout | sortie du processus après SessionEnd → Paused",
            from: Session {
                ended_cleanly: true,
                ..session(Done, None)
            },
            event: Event::ProcessExited {
                closed_by_user: false,
            },
            to: (Paused, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "tout | sortie du processus fermé par l'utilisateur → Paused",
            from: with_pending(session(Waiting, Some(Permission))),
            event: Event::ProcessExited {
                closed_by_user: true,
            },
            to: (Paused, None),
            effects: vec![Effect::ReleasePermissions],
            check: |s| assert_eq!(s.pending_permission, None),
        },
        Row {
            line: "tout | sortie du processus sans SessionEnd → Crashed",
            from: session(Working, None),
            event: Event::ProcessExited {
                closed_by_user: false,
            },
            to: (Crashed, None),
            effects: vec![Effect::Notify],
            check: none,
        },
        Row {
            line: "tout état vivant | sortie de l'appli → Paused",
            from: session(Working, None),
            event: Event::AppQuit,
            to: (Paused, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "Paused (pas vivant) | UserPromptSubmit → inchangé",
            from: session(Paused, None),
            event: Event::UserPromptSubmit,
            to: (Paused, None),
            effects: vec![],
            check: none,
        },
        Row {
            line: "Crashed (pas vivant) | Stop → inchangé",
            from: session(Crashed, None),
            event: Event::Stop {
                last_assistant_message: some("OK"),
            },
            to: (Crashed, None),
            effects: vec![],
            check: |s| assert_eq!(s.last_message, None),
        },
        Row {
            line: "Crashed (pas vivant) | sortie de l'appli → inchangé",
            from: session(Crashed, None),
            event: Event::AppQuit,
            to: (Crashed, None),
            effects: vec![],
            check: none,
        },
    ]
}

#[test]
fn every_transition_row() {
    for row in rows() {
        let (next, effects) = transition(&row.from, &row.event, NOW);
        assert_eq!(
            (next.state, next.waiting_kind),
            row.to,
            "state for « {} »",
            row.line
        );
        assert_eq!(effects, row.effects, "effects for « {} »", row.line);
        let changed = (row.from.state, row.from.waiting_kind) != row.to;
        let expected_since = if changed || row.event == Event::Launched {
            NOW
        } else {
            BEFORE
        };
        assert_eq!(
            next.state_changed_at, expected_since,
            "state_changed_at for « {} »",
            row.line
        );
        assert_eq!(next.conversation_id, SID);
        (row.check)(&next);
    }
}

/// A full permission turn as Claude Code sends it.
#[test]
fn permission_turn_sequence() {
    let mut s = Session::starting(SID, BEFORE);
    let events = [
        Event::SessionStart {
            session_id: some(SID),
            source: some("startup"),
        },
        Event::UserPromptSubmit,
        Event::PreToolUse {
            tool_name: "Bash".into(),
            tool_input: bash("touch spike-1.txt"),
            cwd: None,
        },
        Event::PermissionRequest {
            tool_name: "Bash".into(),
            tool_input: bash("touch spike-1.txt"),
            cwd: None,
        },
        Event::Notification {
            notification_type: some("permission_prompt"),
        },
        Event::PostToolUse {
            tool_name: "Bash".into(),
            tool_input: bash("touch spike-1.txt"),
            cwd: None,
        },
        Event::Stop {
            last_assistant_message: some("Fichier créé."),
        },
        Event::Notification {
            notification_type: some("idle_prompt"),
        },
    ];
    let mut seen = Vec::new();
    for e in &events {
        s = transition(&s, e, NOW).0;
        seen.push((s.state, s.waiting_kind));
    }
    assert_eq!(
        seen,
        vec![
            (Idle, None),
            (Working, None),
            (Working, None),
            (Waiting, Some(Permission)),
            (Waiting, Some(Permission)),
            (Working, None),
            (Done, None),
            (Done, None),
        ]
    );
}

/// A pending request stored before `tool_input` existed matches on its summary.
#[test]
fn legacy_pending_permission_matches_on_summary() {
    let pending: PendingPermission =
        serde_json::from_str(r#"{"tool_name":"Bash","summary":"Commande : rm -rf dist"}"#)
            .expect("legacy json");
    assert_eq!(pending.tool_input, Value::Null);
    assert!(pending.matches("Bash", &bash("rm -rf dist"), None));
    assert!(!pending.matches("Bash", &bash("ls"), None));
    assert!(!pending.matches("Read", &bash("rm -rf dist"), None));
}

/// Two sub-agents: B's auto-allowed tools run while A's Bash request is
/// shown; the ring stays red until A's own PostToolUse.
#[test]
fn parallel_tool_does_not_leave_the_permission() {
    let mut s = with_pending(session(Waiting, Some(Permission)));
    let read = json!({ "file_path": "/w/a.rs" });
    for e in [
        Event::PreToolUse {
            tool_name: "Read".into(),
            tool_input: read.clone(),
            cwd: some("/w"),
        },
        post("Read", read),
        Event::Notification {
            notification_type: some("permission_prompt"),
        },
    ] {
        s = transition(&s, &e, NOW).0;
        assert_eq!(
            (s.state, s.waiting_kind),
            (Waiting, Some(Permission)),
            "{e:?}"
        );
        assert!(s.pending_permission.is_some(), "{e:?}");
    }
    let (s, effects) = transition(&s, &post("Bash", bash("rm -rf dist")), NOW);
    assert_eq!((s.state, s.pending_permission), (Working, None));
    assert_eq!(effects, vec![Effect::ReleasePermissions]);
}
