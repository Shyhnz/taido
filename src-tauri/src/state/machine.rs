//! State machine of a Claude session. Pure: `transition` maps the current
//! session, an event and the current instant to the next session and the effects to run.
//! The router (`session_service`) persists the result and runs the effects.
//!
//! Scope: a conversation change (`SessionStart` with another `session_id`),
//! resuming and the crash at startup are only logged; permission requests are
//! not held, so the "queue" is the first pending request, set by
//! `PermissionRequest` and cleared by the `PostToolUse` or `PostToolUseFailure` of that same
//! tool (`tool_name` + `tool_input`), `Stop`, `StopFailure`,
//! `UserPromptSubmit`, Interrupt and the end of the process.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::i18n::Language;
use crate::model::{SessionState, WaitingKind};
use crate::state::summary;

/// First pending permission request (`agent_sessions.pending_permission`, JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingPermission {
    pub tool_name: String,
    pub summary: String,
    /// Input of the requested tool, to recognise its `PostToolUse`. Rows written
    /// before it existed read as `null` and match on the summary.
    #[serde(default)]
    pub tool_input: Value,
}

impl PendingPermission {
    /// The tool run `tool_name(tool_input)` is the one this request asked for: same tool, and
    /// same input or, failing that, the same summary (tolerates extra fields).
    pub fn matches(
        &self,
        lang: Language,
        tool_name: &str,
        tool_input: &Value,
        cwd: Option<&str>,
    ) -> bool {
        self.tool_name == tool_name
            && ((!self.tool_input.is_null() && self.tool_input == *tool_input)
                || self.summary == summary::permission(lang, tool_name, tool_input, cwd))
    }
}

/// What the machine knows of a session (the state columns of `agent_sessions`).
#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    /// The conversation this row follows (`--session-id` at launch).
    pub conversation_id: String,
    pub state: SessionState,
    /// Set when `state` is `Waiting`.
    pub waiting_kind: Option<WaitingKind>,
    /// Summary of the last tool started (`PreToolUse`).
    pub activity: Option<String>,
    /// Claude's last message (`Stop`), 500 characters max.
    pub last_message: Option<String>,
    /// The question the last message ends with, detected on the full message; set in
    /// Waiting(Question) only.
    pub question: Option<String>,
    pub pending_permission: Option<PendingPermission>,
    /// `StopFailure.error`, set in state Error only.
    pub error_kind: Option<String>,
    /// A `SessionEnd` was received: the coming exit is not a crash.
    pub ended_cleanly: bool,
    /// Instant the session entered its state (« depuis… »).
    pub state_changed_at: String,
}

impl Session {
    /// A session just launched (Starting).
    pub fn starting(conversation_id: &str, now: &str) -> Self {
        Session {
            conversation_id: conversation_id.to_string(),
            state: SessionState::Starting,
            waiting_kind: None,
            activity: None,
            last_message: None,
            question: None,
            pending_permission: None,
            error_kind: None,
            ended_cleanly: false,
            state_changed_at: now.to_string(),
        }
    }
}

/// Inputs of the machine: decoded hooks, timers and user or process actions.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The process was launched (new session; resuming arrives).
    Launched,
    /// 8 s after the launch.
    StartingTimeout,
    SessionStart {
        session_id: Option<String>,
        source: Option<String>,
    },
    UserPromptSubmit,
    PreToolUse {
        tool_name: String,
        tool_input: Value,
        /// Folder of the session (payload `cwd`), to show relative paths.
        cwd: Option<String>,
    },
    PostToolUse {
        tool_name: String,
        tool_input: Value,
        cwd: Option<String>,
    },
    PostToolUseFailure {
        tool_name: String,
        tool_input: Value,
        cwd: Option<String>,
    },
    PermissionRequest {
        tool_name: String,
        tool_input: Value,
        cwd: Option<String>,
    },
    Notification {
        notification_type: Option<String>,
    },
    Stop {
        last_assistant_message: Option<String>,
    },
    StopFailure {
        error: Option<String>,
    },
    SessionEnd {
        reason: Option<String>,
    },
    /// « Interrompre », or Escape typed in the terminal.
    Interrupt,
    /// The process exited; `closed_by_user` when the user closed the terminal (or quit).
    ProcessExited {
        closed_by_user: bool,
    },
    /// The app quits (⌘Q).
    AppQuit,
}

/// What the caller must do after a transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// A situation not handled yet (conversation change, resume, compaction, `/clear`): logged.
    Log(String),
    /// The permission queue was emptied: held requests get `{}`.
    ReleasePermissions,
    /// A system notification is due.
    Notify,
}

/// `Notification.notification_type` values that mean Claude waits for a terminal input.
const INPUT_NOTIFICATIONS: &[&str] = &[
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
];

/// Applies `event` to `current` at instant `now` (ISO string); `lang` words the texts it stores. Every row of the state table; anything else leaves the session unchanged.
pub fn transition(
    lang: Language,
    current: &Session,
    event: &Event,
    now: &str,
) -> (Session, Vec<Effect>) {
    use SessionState::{Crashed, Done, Error, Idle, Paused, Starting, Waiting, Working};
    let mut next = current.clone();
    let mut effects = Vec::new();
    let live = current.state.is_live();
    let waiting = |kind| (Waiting, Some(kind));

    let target: Option<(SessionState, Option<WaitingKind>)> = match event {
        Event::Launched => {
            // A launch always starts a new period, even from Starting.
            next = Session::starting(&current.conversation_id, now);
            None
        }
        Event::StartingTimeout => (current.state == Starting).then(|| waiting(WaitingKind::Input)),
        Event::SessionStart { session_id, source } => {
            let source_name = source.as_deref().unwrap_or("unknown");
            match session_id
                .as_deref()
                .filter(|id| *id != current.conversation_id)
            {
                Some(other) => {
                    effects.push(Effect::Log(format!(
                        "conversation change to {other} (source {source_name}) not handled yet"
                    )));
                    None
                }
                None => match source.as_deref() {
                    Some("compact") => {
                        effects.push(Effect::Log("context compacted".into()));
                        None
                    }
                    None | Some("startup") | Some("resume") => {
                        if source.as_deref() == Some("resume") {
                            effects.push(Effect::Log("conversation resumed".into()));
                        }
                        let starting = current.state == Starting
                            || (current.state == Waiting
                                && current.waiting_kind == Some(WaitingKind::Input));
                        starting.then_some((Idle, None))
                    }
                    Some(other) => {
                        effects.push(Effect::Log(format!(
                            "SessionStart with source {other} for the same conversation ignored"
                        )));
                        None
                    }
                },
            }
        }
        Event::UserPromptSubmit => live.then(|| {
            next.activity = None;
            release(&mut next, &mut effects);
            (Working, None)
        }),
        Event::PreToolUse {
            tool_name,
            tool_input,
            cwd,
        } => {
            if live {
                next.activity = Some(summary::activity(
                    lang,
                    tool_name,
                    tool_input,
                    cwd.as_deref(),
                ))
                .filter(|a| !a.is_empty());
            }
            // A pending permission keeps the session waiting.
            (live && current.pending_permission.is_none()).then_some((Working, None))
        }
        Event::PostToolUse {
            tool_name,
            tool_input,
            cwd,
        }
        | Event::PostToolUseFailure {
            tool_name,
            tool_input,
            cwd,
        } => {
            // Only the requested tool means the user answered in the terminal;
            // another tool (a parallel sub-agent) leaves the request pending.
            let answered = current
                .pending_permission
                .as_ref()
                .is_none_or(|p| p.matches(lang, tool_name, tool_input, cwd.as_deref()));
            (live && answered).then(|| {
                release(&mut next, &mut effects);
                (Working, None)
            })
        }
        Event::PermissionRequest {
            tool_name,
            tool_input,
            cwd,
        } => live.then(|| {
            // The first request stays shown (« +1 en attente » arrives with the queue).
            if next.pending_permission.is_none() {
                next.pending_permission = Some(PendingPermission {
                    tool_name: tool_name.clone(),
                    summary: summary::permission(lang, tool_name, tool_input, cwd.as_deref()),
                    tool_input: tool_input.clone(),
                });
            }
            waiting(WaitingKind::Permission)
        }),
        Event::Notification { notification_type } => match notification_type.as_deref() {
            // Safety net when the PermissionRequest was missed.
            Some("permission_prompt") if current.state == Working => {
                Some(waiting(WaitingKind::Permission))
            }
            Some(t) if live && INPUT_NOTIFICATIONS.contains(&t) => {
                Some(waiting(WaitingKind::Input))
            }
            // `idle_prompt`, `auth_success` and the others: a finished turn must not turn red.
            _ => None,
        },
        Event::Stop {
            last_assistant_message,
        } => live.then(|| {
            let message = last_assistant_message
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty());
            next.last_message = message.map(|m| summary::truncate(m, summary::LAST_MESSAGE_MAX));
            release(&mut next, &mut effects);
            // Detected on the full message: the stored one may have lost its end.
            next.question = message.and_then(summary::question);
            match next.question {
                Some(_) => waiting(WaitingKind::Question),
                None => (Done, None),
            }
        }),
        Event::StopFailure { error } => live.then(|| {
            let kind = error
                .as_deref()
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .unwrap_or("unknown");
            next.error_kind = Some(kind.to_string());
            // The turn is over: nothing can still be waiting for an answer.
            release(&mut next, &mut effects);
            (Error, None)
        }),
        Event::SessionEnd { reason } => {
            next.ended_cleanly = true;
            if reason.as_deref() == Some("clear") {
                effects.push(Effect::Log(
                    "conversation cleared, a new conversation follows".into(),
                ));
            }
            None
        }
        Event::Interrupt => live.then(|| {
            release(&mut next, &mut effects);
            (Idle, None)
        }),
        Event::ProcessExited { closed_by_user } => {
            release(&mut next, &mut effects);
            Some(if current.ended_cleanly || *closed_by_user {
                (Paused, None)
            } else {
                (Crashed, None)
            })
        }
        Event::AppQuit => live.then(|| {
            release(&mut next, &mut effects);
            (Paused, None)
        }),
    };

    if let Some((state, kind)) = target {
        next.state = state;
        next.waiting_kind = kind;
    }
    if next.state != Error {
        next.error_kind = None;
    }
    if (next.state, next.waiting_kind) != (Waiting, Some(WaitingKind::Question)) {
        next.question = None;
    }
    if (next.state, next.waiting_kind) != (current.state, current.waiting_kind) {
        next.state_changed_at = now.to_string();
        if notifies(&next) {
            effects.push(Effect::Notify);
        }
    }
    (next, effects)
}

/// Empties the permission queue.
fn release(next: &mut Session, effects: &mut Vec<Effect>) {
    if next.pending_permission.take().is_some() {
        effects.push(Effect::ReleasePermissions);
    }
}

/// Entering this state notifies: Waiting, Done, Crashed, and blocking errors.
fn notifies(session: &Session) -> bool {
    match session.state {
        SessionState::Waiting | SessionState::Done | SessionState::Crashed => true,
        SessionState::Error => session
            .error_kind
            .as_deref()
            .is_some_and(summary::is_blocking_error),
        _ => false,
    }
}

#[cfg(test)]
mod tests;
