//! Notifications: a discreet system notification, without sound, when Claude
//! finishes or waits for the user, unless the user is already looking at the task. A click
//! brings the app forward on the terminal of that session.
//!
//! The decisions ([`Gate`], [`Notifier`]) know nothing of the system: the display goes to a
//! [`Banner`] (macOS: `notify/macos.rs`, only in the installed app).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::i18n::{self, Language};
use crate::model::{Agent, SessionState};
use crate::state::machine::Session;

#[cfg(target_os = "macos")]
pub mod macos;

/// At most one notification per task in this window.
pub const PER_TASK_INTERVAL: Duration = Duration::from_secs(10);

/// One notification: « {Projet} · {Tâche} », then the state of the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub task_id: String,
    /// The Claude terminal of the session, shown on click.
    pub terminal_id: Option<String>,
    pub title: String,
    pub body: String,
}

/// Shows and withdraws system notifications. One per task: a new one replaces the last.
pub trait Banner: Send + Sync {
    fn show(&self, notice: &Notice);
    fn withdraw(&self, task_id: &str);
}

/// What the user is looking at, and when each task was last notified.
#[derive(Debug, Default)]
pub struct Gate {
    focused: bool,
    open_task: Option<String>,
    sent: HashMap<String, Instant>,
}

impl Gate {
    /// The task is in front of the user: the window has the focus and shows its panel.
    pub fn watching(&self, task_id: &str) -> bool {
        self.focused && self.open_task.as_deref() == Some(task_id)
    }

    /// Whether to notify the task now; records the notification when so.
    pub fn admit(&mut self, task_id: &str, now: Instant) -> bool {
        self.sent
            .retain(|_, at| now.saturating_duration_since(*at) < PER_TASK_INTERVAL);
        if self.watching(task_id) || self.sent.contains_key(task_id) {
            return false;
        }
        self.sent.insert(task_id.to_string(), now);
        true
    }

    /// Returns the task the user now looks at, if any.
    pub fn set_focused(&mut self, focused: bool) -> Option<&str> {
        self.focused = focused;
        self.watched()
    }

    /// Returns the task the user now looks at, if any.
    pub fn set_open_task(&mut self, task_id: Option<String>) -> Option<&str> {
        self.open_task = task_id;
        self.watched()
    }

    fn watched(&self) -> Option<&str> {
        self.open_task.as_deref().filter(|_| self.focused)
    }
}

/// Sends the notices that pass the [`Gate`] and withdraws a task's notification once the
/// user looks at the task.
pub struct Notifier {
    gate: Mutex<Gate>,
    /// Tasks notified and not looked at since, with the terminal to show on click.
    shown: Mutex<HashMap<String, Option<String>>>,
    /// `None` outside the installed macOS app: the notices are only logged.
    banner: Option<Arc<dyn Banner>>,
}

impl Notifier {
    pub fn new(banner: Option<Arc<dyn Banner>>) -> Self {
        Notifier {
            gate: Mutex::new(Gate::default()),
            shown: Mutex::new(HashMap::new()),
            banner,
        }
    }

    /// A session of the task finished or waits (the setting is checked by the caller).
    pub fn notify(&self, notice: Notice) {
        let admitted = match self.gate.lock() {
            Ok(mut gate) => gate.admit(&notice.task_id, Instant::now()),
            Err(e) => {
                log::warn!("notification gate poisoned: {e}");
                return;
            }
        };
        if !admitted {
            return;
        }
        if let Ok(mut shown) = self.shown.lock() {
            shown.insert(notice.task_id.clone(), notice.terminal_id.clone());
        }
        match &self.banner {
            Some(banner) => banner.show(&notice),
            None => log::info!(
                "notification (not shown): {} · {}",
                notice.title,
                notice.body
            ),
        }
    }

    /// Focus of the main window.
    pub fn set_focused(&self, focused: bool) {
        let watched = match self.gate.lock() {
            Ok(mut gate) => gate.set_focused(focused).map(str::to_string),
            Err(e) => {
                log::warn!("notification gate poisoned: {e}");
                return;
            }
        };
        if let Some(task_id) = watched {
            self.seen(&task_id);
        }
    }

    /// Task whose panel is open (`set_open_task`).
    pub fn set_open_task(&self, task_id: Option<String>) {
        let watched = match self.gate.lock() {
            Ok(mut gate) => gate.set_open_task(task_id).map(str::to_string),
            Err(e) => {
                log::warn!("notification gate poisoned: {e}");
                return;
            }
        };
        if let Some(task_id) = watched {
            self.seen(&task_id);
        }
    }

    /// A notification was clicked: the terminal of its session, when known.
    pub fn clicked(&self, task_id: &str) -> Option<String> {
        self.shown
            .lock()
            .ok()
            .and_then(|shown| shown.get(task_id).cloned())
            .flatten()
    }

    /// The user looks at the task: its notification leaves the notification center.
    fn seen(&self, task_id: &str) {
        let was_shown = self
            .shown
            .lock()
            .map(|mut shown| shown.remove(task_id).is_some())
            .unwrap_or(false);
        if let (true, Some(banner)) = (was_shown, &self.banner) {
            banner.withdraw(task_id);
        }
    }
}

/// « Globex · Export CSV », or the task alone outside any project.
pub fn title(subject: Option<&str>, task: &str) -> String {
    match subject {
        Some(subject) => format!("{subject} · {task}"),
        None => task.to_string(),
    }
}

/// The state of the session, as the second line says it (`line` in `src/i18n`): only the
/// state, never what Claude said.
pub fn body(lang: Language, agent: Agent, session: &Session) -> String {
    let name = agent.label();
    match session.state {
        SessionState::Waiting => i18n::agent_waiting(lang, name),
        SessionState::Done => i18n::agent_done(lang, name),
        SessionState::Crashed => i18n::session_stopped(lang).into(),
        SessionState::Error => i18n::error_text(lang, session.error_kind.as_deref()),
        _ => name.into(),
    }
}

#[cfg(test)]
mod tests;
