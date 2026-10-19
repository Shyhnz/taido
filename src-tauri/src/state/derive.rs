//! Derivation of a task's ring, second line and aggregates.
//!
//! Pure: the inputs are gathered in [`RingInput`] (the task's completion, its description
//! and its Claude sessions, loaded in bulk by the callers).

use std::cmp::Ordering;

use crate::model::{LineKind, LineTone, Ring, SessionState, SubjectDot, TaskLine, WaitingKind};
use crate::state::summary;

/// Maximum length (in characters) of the description line.
pub const DESCRIPTION_LINE_MAX: usize = 200;

/// What the ring and the line need to know of one Claude session of the task.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionFacts {
    /// The tool running the session.
    pub agent: crate::model::Agent,
    pub state: SessionState,
    pub waiting_kind: Option<WaitingKind>,
    /// Its terminal is open (`terminals.closed_at IS NULL`).
    pub terminal_open: bool,
    pub activity: Option<String>,
    pub last_message: Option<String>,
    /// The question of a Waiting(Question) session, detected on the full message.
    pub question: Option<String>,
    /// Summary of the first pending permission request.
    pub permission: Option<String>,
    pub error_kind: Option<String>,
    pub state_changed_at: String,
    pub updated_at: String,
    pub started_at: String,
}

/// Facts about a task the ring depends on.
#[derive(Debug, Clone, Copy)]
pub struct RingInput<'a> {
    pub completed_at: Option<&'a str>,
    pub description: &'a str,
    pub sessions: &'a [SessionFacts],
}

/// Ring of a session state.
pub fn session_ring(state: SessionState) -> Ring {
    match state {
        SessionState::Starting => Ring::Starting,
        SessionState::Idle => Ring::Idle,
        SessionState::Working => Ring::Working,
        SessionState::Waiting => Ring::Waiting,
        SessionState::Done => Ring::Done,
        SessionState::Error => Ring::Error,
        SessionState::Paused => Ring::Paused,
        SessionState::Crashed => Ring::Crashed,
    }
}

/// Most recent first: last update, then start.
fn recency(a: &SessionFacts, b: &SessionFacts) -> Ordering {
    b.updated_at
        .cmp(&a.updated_at)
        .then_with(|| b.started_at.cmp(&a.started_at))
}

/// The session the ring shows. By design: the ring describes a Claude that
/// runs, nothing else. Candidates are the sessions whose terminal is open, plus a Crashed
/// session (its « ! » stays until the user closes the tab, which settles it); the most
/// urgent wins (the most recent change on a tie). Without any, the task is a plain task:
/// ended sessions are history, not a state.
fn shown(sessions: &[SessionFacts]) -> Option<SessionFacts> {
    sessions
        .iter()
        .filter(|s| (s.terminal_open && s.state.is_live()) || s.state == SessionState::Crashed)
        .min_by(|a, b| {
            urgency(session_ring(a.state))
                .cmp(&urgency(session_ring(b.state)))
                .then_with(|| b.state_changed_at.cmp(&a.state_changed_at))
                .then_with(|| recency(a, b))
        })
        .cloned()
}

/// Ring of a task: Completed, else the shown session's state, else Human.
///
/// Without a running (or crashed) Claude, a plain task: Human.
pub fn ring(input: &RingInput<'_>) -> Ring {
    if input.completed_at.is_some() {
        return Ring::Completed;
    }
    match shown(input.sessions).map(|s| s.state) {
        None | Some(SessionState::Paused) => Ring::Human,
        Some(state) => session_ring(state),
    }
}

/// Second line; `None` when there is nothing to show. `ring` is `ring(input)`.
pub fn line(input: &RingInput<'_>, ring: Ring) -> Option<TaskLine> {
    match ring {
        Ring::Completed => Some(TaskLine {
            kind: LineKind::Completed,
            agent: None,
            text: None,
            at: input.completed_at.map(str::to_string),
            tone: LineTone::Faint,
        }),
        Ring::Human => first_line(input.description).map(|text| TaskLine {
            kind: LineKind::Description,
            agent: None,
            text: Some(text),
            at: None,
            tone: LineTone::Muted,
        }),
        _ => shown(input.sessions).as_ref().map(session_line),
    }
}

/// Second line of a Claude session. Texts the UI renders from a template carry
/// only their variable part.
pub fn session_line(s: &SessionFacts) -> TaskLine {
    let (kind, text, at, tone) = match s.state {
        SessionState::Waiting => match s.waiting_kind {
            Some(WaitingKind::Permission) => (
                LineKind::WaitingPermission,
                s.permission.clone(),
                None,
                LineTone::Waiting,
            ),
            Some(WaitingKind::Question) => (
                LineKind::WaitingQuestion,
                s.question.clone(),
                None,
                LineTone::Waiting,
            ),
            Some(WaitingKind::Input) | None => {
                (LineKind::WaitingInput, None, None, LineTone::Waiting)
            }
        },
        SessionState::Error => (
            LineKind::Error,
            Some(summary::error_text(s.error_kind.as_deref())),
            None,
            LineTone::Primary,
        ),
        SessionState::Crashed => (LineKind::Crashed, None, None, LineTone::Primary),
        SessionState::Done => (
            LineKind::Done,
            s.last_message.as_deref().and_then(summary::done_text),
            None,
            LineTone::Done,
        ),
        SessionState::Working => (LineKind::Working, s.activity.clone(), None, LineTone::Muted),
        SessionState::Starting => (LineKind::Starting, None, None, LineTone::Muted),
        SessionState::Idle => (LineKind::Idle, None, None, LineTone::Muted),
        SessionState::Paused => (
            LineKind::Paused,
            None,
            Some(s.state_changed_at.clone()),
            LineTone::Muted,
        ),
    };
    TaskLine {
        kind,
        agent: Some(s.agent),
        text,
        at,
        tone,
    }
}

/// Instant the current ring state started: completion time, or when the shown session
/// entered its state; `None` for Human.
pub fn ring_since(input: &RingInput<'_>, ring: Ring) -> Option<String> {
    match ring {
        Ring::Completed => input.completed_at.map(str::to_string),
        Ring::Human => None,
        _ => shown(input.sessions).map(|s| s.state_changed_at),
    }
}

/// Sort rank of a ring, most urgent first.
pub fn urgency(ring: Ring) -> u8 {
    match ring {
        Ring::Waiting => 0,
        Ring::Error => 1,
        Ring::Crashed => 2,
        Ring::Done => 3,
        Ring::Working | Ring::Starting => 4,
        Ring::Idle => 5,
        Ring::Paused => 6,
        Ring::Human => 7,
        Ring::Completed => 8,
    }
}

/// Second line of a row in a list: only Claude's state, never the description
/// nor the completion. `None` for Human and Completed tasks.
pub fn row_line(input: &RingInput<'_>, ring: Ring) -> Option<TaskLine> {
    match ring {
        Ring::Human | Ring::Completed => None,
        _ => line(input, ring),
    }
}

/// "Claude attend": the group at the top of Today.
pub fn is_claude_waiting(ring: Ring) -> bool {
    matches!(
        ring,
        Ring::Waiting | Ring::Error | Ring::Crashed | Ring::Done
    )
}

/// Rings that bring a task into Today whatever its due date (Starting counts as
/// Working).
pub fn is_active_today(ring: Ring) -> bool {
    is_claude_waiting(ring) || matches!(ring, Ring::Working | Ring::Starting | Ring::Idle)
}

/// Dot of a subject from the rings of its open tasks: red if one waits, else
/// black for an error or a crash, else green for a finished turn, else nothing.
pub fn subject_dot(rings: impl IntoIterator<Item = Ring>) -> Option<SubjectDot> {
    let mut dot = None;
    for ring in rings {
        dot = match (ring, dot) {
            (Ring::Waiting, _) => return Some(SubjectDot::Waiting),
            (Ring::Error | Ring::Crashed, _) => Some(SubjectDot::Error),
            (Ring::Done, None) => Some(SubjectDot::Done),
            (_, current) => current,
        };
    }
    dot
}

/// First non-empty line of a description, trimmed and truncated with an ellipsis.
pub fn first_line(description: &str) -> Option<String> {
    let line = description.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(summary::truncate(line, DESCRIPTION_LINE_MAX))
}

#[cfg(test)]
mod tests;
