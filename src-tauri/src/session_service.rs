//! Claude sessions at run time: routes hooks, timers, Escape, « Interrompre »
//! and process exits to the pure state machine, persists each transition in a short
//! transaction, and emits the resulting task states in batches (at most one per
//! task every 50 ms).
//!
//! It knows nothing of Tauri: the batches go to a [`FlushSink`] (`lib.rs` turns them into
//! `task_state_changed`, `data_changed` and `counts_changed`, and hands the notices to the
//! notifier). The database lock is held only for the database work, never while writing to a
//! PTY or emitting.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};

use crate::agents::usage;
use crate::db::agent_sessions::{self, SessionRow};
use crate::db::{self, journal, settings, terminals as term_rows};
use crate::error::{AppError, AppResult};
use crate::events::TaskStateChanged;
use crate::hooks::payload;
use crate::model::{
    Agent, ContextUsage, Counts, JournalKind, SessionState, TerminalInfo, WaitingKind,
};
use crate::notify::{self, Notice};
use crate::state::machine::{transition, Effect, Event};
use crate::views::{self, rows};

/// What a single Escape keystroke writes.
pub const ESCAPE: &str = "\x1b";

/// Delays of the service; shorter in tests.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// Starting without `SessionStart` for this long → Waiting(Input).
    pub starting_timeout: Duration,
    /// Changes are batched over this window.
    pub batch_window: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            starting_timeout: Duration::from_secs(8),
            batch_window: Duration::from_millis(50),
        }
    }
}

/// One batch: the new ring and line of each changed task, then fresh counters, and the
/// notifications to show.
#[derive(Debug, Clone)]
pub struct Flush {
    pub changes: Vec<TaskStateChanged>,
    pub counts: Option<Counts>,
    pub notices: Vec<Notice>,
}

/// A session just entered a state that notifies; its title is read with the batch.
#[derive(Debug, Clone)]
struct PendingNotice {
    task_id: String,
    terminal_id: Option<String>,
    body: String,
}

pub type FlushSink = Arc<dyn Fn(Flush) + Send + Sync>;

/// Called when a terminal now runs another conversation: (terminal id, session id). The PTY
/// manager keeps `TerminalInfo.agent_session_id` in step.
pub type ReattachHook = Arc<dyn Fn(&str, &str) + Send + Sync>;

struct Inner {
    db: Arc<Mutex<Connection>>,
    reattach: Mutex<Option<ReattachHook>>,
    /// Tasks changed since the last batch, with the instant of their last change.
    dirty: Mutex<BTreeMap<String, String>>,
    /// Sessions to notify with the next batch.
    notices: Mutex<Vec<PendingNotice>>,
    /// Wakes the batching thread.
    wake: Mutex<Sender<()>>,
}

pub struct SessionService {
    inner: Arc<Inner>,
    timing: Timing,
}

impl SessionService {
    /// Starts the batching thread, which stops once the service is dropped.
    pub fn new(db: Arc<Mutex<Connection>>, sink: FlushSink, timing: Timing) -> Self {
        let (tx, rx) = mpsc::channel();
        let inner = Arc::new(Inner {
            db,
            reattach: Mutex::new(None),
            dirty: Mutex::new(BTreeMap::new()),
            notices: Mutex::new(Vec::new()),
            wake: Mutex::new(tx),
        });
        let weak = Arc::downgrade(&inner);
        let window = timing.batch_window;
        let spawned = std::thread::Builder::new()
            .name("task-states".into())
            .spawn(move || run_batches(weak, rx, sink, window));
        if let Err(e) = spawned {
            log::error!("cannot start the task state thread: {e}");
        }
        SessionService { inner, timing }
    }

    /// Set once at startup (the PTY manager is created after this service).
    pub fn set_reattach_hook(&self, hook: ReattachHook) {
        if let Ok(mut slot) = self.inner.reattach.lock() {
            *slot = Some(hook);
        }
    }

    /// The hook server's recorder: logs the raw event (diagnostics), then routes it to the
    /// session of the terminal (`X-Terminal-Id`). Failures are logged, never returned: Claude
    /// Code gets `{}` whatever happens.
    pub fn on_hook(&self, terminal_id: Option<&str>, name: &str, payload: &str) {
        if let Err(e) = self.inner.route_hook(terminal_id, name, payload) {
            log::warn!("cannot route hook event {name}: {e}");
        }
    }

    /// A Claude terminal was opened (its session row is inserted Starting): the launch goes
    /// through the machine (its task's ring changes), and a session that receives no
    /// `SessionStart` within the timeout goes Waiting(Input).
    pub fn launched(&self, info: &TerminalInfo) {
        let Some(session_id) = info.agent_session_id.clone() else {
            return;
        };
        // Only while still Starting: a hook may already have moved it on.
        let launched = self.inner.lock().and_then(|conn| {
            self.inner.apply(&conn, &Event::Launched, |c| {
                let row = agent_sessions::get(c, &session_id)?;
                Ok(Some(row).filter(|r| r.session.state == SessionState::Starting))
            })
        });
        match launched {
            Ok(true) => {}
            // Unchanged within the same millisecond: the ring still changed (Starting).
            Ok(false) => self.inner.mark(&info.task_id, &info.opened_at),
            Err(e) => log::warn!("cannot record the launch of session {session_id}: {e}"),
        }
        let inner = Arc::clone(&self.inner);
        let delay = self.timing.starting_timeout;
        let spawned = std::thread::Builder::new()
            .name("starting-timer".into())
            .spawn(move || {
                std::thread::sleep(delay);
                let applied = inner.lock().and_then(|conn| {
                    inner.apply(&conn, &Event::StartingTimeout, |c| {
                        agent_sessions::get(c, &session_id).map(Some)
                    })
                });
                if let Err(e) = applied {
                    log::warn!("starting timeout of session {session_id} failed: {e}");
                }
            });
        if let Err(e) = spawned {
            log::warn!("cannot start the starting timer: {e}");
        }
    }

    /// A terminal's process exited: the terminal is closed in the database and its session
    /// goes Paused (`SessionEnd` received, or closed by the user) or Crashed.
    /// Returns whether the user had closed it.
    pub fn exited(&self, info: &TerminalInfo) -> AppResult<bool> {
        let conn = self.inner.lock()?;
        let by_user = term_rows::mark_exited(&conn, &info.id, info.exit_code)?;
        let event = Event::ProcessExited {
            closed_by_user: by_user,
        };
        self.inner
            .apply(&conn, &event, |c| agent_sessions::by_terminal(c, &info.id))?;
        Ok(by_user)
    }

    /// Text written to a terminal: a lone Escape in a Claude terminal whose session works or
    /// waits for a permission is an interruption. Call after the write.
    pub fn typed(&self, terminal_id: &str, data: &str) -> AppResult<()> {
        if data != ESCAPE {
            return Ok(());
        }
        let conn = self.inner.lock()?;
        self.inner.apply(&conn, &Event::Interrupt, |c| {
            Ok(agent_sessions::by_terminal(c, terminal_id)?.filter(|row| {
                let s = &row.session;
                s.state == SessionState::Working
                    || (s.state == SessionState::Waiting
                        && s.waiting_kind == Some(WaitingKind::Permission))
            }))
        })?;
        Ok(())
    }

    /// Terminal currently running the session, for « Interrompre ».
    pub fn terminal_of(&self, session_id: &str) -> AppResult<String> {
        let conn = self.inner.lock()?;
        agent_sessions::get(&conn, session_id)?
            .current_terminal_id
            .ok_or_else(|| AppError::NotFound(format!("terminal of agent session {session_id}")))
    }

    /// « Interrompre »: the session goes Idle and its permission queue is emptied.
    /// The caller writes Escape to the terminal first.
    pub fn interrupt(&self, session_id: &str) -> AppResult<()> {
        let conn = self.inner.lock()?;
        self.inner.apply(&conn, &Event::Interrupt, |c| {
            agent_sessions::get(c, session_id).map(Some)
        })?;
        Ok(())
    }
}

impl Inner {
    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        Ok(self.db.lock()?)
    }

    /// Queued before the task is marked: the batch that takes it loads its task.
    fn queue_notice(&self, notice: PendingNotice) {
        match self.notices.lock() {
            Ok(mut notices) => notices.push(notice),
            Err(e) => log::warn!("notice queue poisoned: {e}"),
        }
    }

    /// Records that a task changed and wakes the batching thread.
    fn mark(&self, task_id: &str, at: &str) {
        match self.dirty.lock() {
            Ok(mut dirty) => {
                dirty.insert(task_id.to_string(), at.to_string());
            }
            Err(e) => {
                log::warn!("task state batch poisoned: {e}");
                return;
            }
        }
        if let Ok(wake) = self.wake.lock() {
            // Fails only once the batching thread is gone (shutdown).
            let _ = wake.send(());
        }
    }

    /// Applies `event` to the session `find` returns (none: nothing to do), in one short
    /// transaction. Returns whether the session changed.
    fn apply(
        &self,
        conn: &Connection,
        event: &Event,
        find: impl FnOnce(&Connection) -> AppResult<Option<SessionRow>>,
    ) -> AppResult<bool> {
        let tx = conn.unchecked_transaction()?;
        let Some(row) = find(&tx)? else {
            return Ok(false);
        };
        let now = db::now_utc();
        let (next, effects) = transition(&row.session, event, &now);
        let mut notifies = false;
        for effect in effects {
            match effect {
                Effect::Log(message) => log::info!("session {}: {message}", row.id),
                Effect::Notify => notifies = true,
                // Held permission requests are not built.
                Effect::ReleasePermissions => {}
            }
        }
        if next == row.session {
            return Ok(false);
        }
        agent_sessions::save(&tx, &row.id, &next, &now)?;
        tx.commit()?;
        if notifies {
            self.queue_notice(PendingNotice {
                task_id: row.task_id.clone(),
                terminal_id: row.current_terminal_id.clone(),
                body: notify::body(row.agent, &next),
            });
        }
        self.mark(&row.task_id, &now);
        Ok(true)
    }

    fn route_hook(&self, terminal_id: Option<&str>, name: &str, payload: &str) -> AppResult<()> {
        let hook = payload::decode(name, payload);
        // The transcript is read before taking the database lock.
        let usage = context_update(name, &hook);
        let conn = self.lock()?;
        if let Err(e) = term_rows::log_hook_event(&conn, terminal_id, name, payload) {
            log::warn!("cannot record hook event {name}: {e}");
        }
        let Some(terminal_id) = terminal_id else {
            return Ok(());
        };
        let Some(event) = hook.event else {
            return Ok(());
        };
        let Some(mut row) = agent_sessions::by_terminal(&conn, terminal_id)? else {
            return Ok(());
        };
        // Codex's MCP connection: it is ready (it sends `SessionStart` only with the first
        // message). Claude announces itself with `SessionStart`, its MCP connection says nothing.
        if name == payload::AGENT_READY && row.agent != Agent::Codex {
            return Ok(());
        }
        // Codex announces its conversation id with its first hooks: the provisional one goes.
        // An id Taido already knows (Codex's /resume in a fresh tab) takes its own row back.
        if agent_sessions::is_pending_conversation(&row.session.conversation_id) {
            if let Some(real) = hook.session_id.as_deref() {
                if agent_sessions::conversation_owner(&conn, real)?.is_some() {
                    let source = match &event {
                        Event::SessionStart { source, .. } => source.as_deref(),
                        _ => Some("resume"),
                    };
                    self.switch(&conn, &row, real, source, terminal_id)?;
                    // Any other event goes to the row now attached to the terminal.
                    if !matches!(event, Event::SessionStart { .. }) {
                        self.apply(&conn, &event, |c| {
                            agent_sessions::by_terminal(c, terminal_id)
                        })?;
                    }
                    return Ok(());
                }
                agent_sessions::adopt_conversation(&conn, &row.id, real)?;
                row.session.conversation_id = real.to_string();
            }
        }
        let other = hook
            .session_id
            .as_deref()
            .filter(|id| *id != row.session.conversation_id);
        if let Some(other) = other {
            if let Event::SessionStart { source, .. } = &event {
                // `/clear`, fork, `/resume` typed in Claude: the terminal changes conversation.
                return self.switch(&conn, &row, other, source.as_deref(), terminal_id);
            }
            // A late event of the conversation that just left this terminal.
            log::info!("{name} of another conversation on terminal {terminal_id}: ignored");
            return Ok(());
        }
        self.apply(&conn, &event, |c| {
            agent_sessions::by_terminal(c, terminal_id)
        })?;
        if let Some(usage) = usage {
            match agent_sessions::set_context_usage(&conn, &row.id, usage.as_ref()) {
                Ok(true) => self.mark(&row.task_id, &db::now_utc()),
                Ok(false) => {}
                Err(e) => log::warn!("cannot record the context of {name}: {e}"),
            }
        }
        if let Some((kind, text)) = &hook.trace {
            match journal::add_for_session(&conn, &row.task_id, &row.id, *kind, text) {
                // The history refreshes even when the state did not change (a compaction, a
                // message while Claude already works).
                Ok(()) => self.mark(&row.task_id, &db::now_utc()),
                Err(e) => log::warn!("cannot record the trace of {name}: {e}"),
            }
        }
        Ok(())
    }

    /// Conversation change in a terminal: the old session becomes history, the
    /// new (or known) one is attached Idle; the trace notes `/clear` and the reattachment.
    fn switch(
        &self,
        conn: &Connection,
        row: &SessionRow,
        conversation_id: &str,
        source: Option<&str>,
        terminal_id: &str,
    ) -> AppResult<()> {
        let now = db::now_utc();
        let tx = conn.unchecked_transaction()?;
        let switched =
            agent_sessions::switch_conversation(&tx, row, conversation_id, terminal_id, &now)?;
        if source == Some("clear") {
            journal::add_for_session(&tx, &row.task_id, &row.id, JournalKind::Cleared, "")?;
        }
        if switched.reattached {
            journal::add_for_session(
                &tx,
                &row.task_id,
                &switched.session_id,
                JournalKind::Resumed,
                "",
            )?;
        }
        tx.commit()?;
        log::info!(
            "terminal {terminal_id}: conversation {} → {}",
            row.session.conversation_id,
            conversation_id
        );
        let hook = self.reattach.lock().ok().and_then(|h| h.clone());
        if let Some(hook) = hook {
            hook(terminal_id, &switched.session_id);
        }
        self.mark(&row.task_id, &now);
        // A conversation taken from another task leaves that task's history too.
        if let Some(previous) = switched.previous_task_id.filter(|t| *t != row.task_id) {
            self.mark(&previous, &now);
        }
        Ok(())
    }

    /// Ring and line of each changed task, then the counters and the notices. A subtask's
    /// change is also its parent's: the parent's ring sums up its children's sessions
    ///.
    fn batch(
        &self,
        dirty: &BTreeMap<String, String>,
        pending: &[PendingNotice],
    ) -> AppResult<Flush> {
        let conn = self.lock()?;
        let mut dirty = dirty.clone();
        // A notice taken just before its task was marked.
        for notice in pending {
            if !dirty.contains_key(&notice.task_id) {
                dirty.insert(notice.task_id.clone(), db::now_utc());
            }
        }
        for (parent, at) in parents_of(&conn, &dirty)? {
            let entry = dirty.entry(parent).or_insert_with(|| at.clone());
            if *entry < at {
                *entry = at;
            }
        }
        let ids: Vec<String> = dirty.keys().cloned().collect();
        let tasks = rows::load(&conn, rows::Filter::Ids(&ids))?;
        let changes = tasks
            .iter()
            .map(|t| TaskStateChanged {
                task_id: t.id.clone(),
                subject_id: t.subject.as_ref().map(|s| s.id.clone()),
                ring: t.ring(),
                line: t.row_line(),
                at: dirty.get(&t.id).cloned().unwrap_or_else(db::now_utc),
            })
            .collect();
        let counts = match views::counts(&conn, chrono::Local::now().date_naive()) {
            Ok(counts) => Some(counts),
            Err(e) => {
                log::warn!("cannot compute counts: {e}");
                None
            }
        };
        // An unreadable setting never holds back the rings.
        let notify = !pending.is_empty()
            && settings::get(&conn)
                .map(|s| s.notifications)
                .unwrap_or_else(|e| {
                    log::warn!("cannot read the notification setting: {e}");
                    false
                });
        let notices = if !notify {
            Vec::new()
        } else {
            pending
                .iter()
                .filter_map(|n| {
                    let task = tasks.iter().find(|t| t.id == n.task_id)?;
                    Some(Notice {
                        task_id: n.task_id.clone(),
                        terminal_id: n.terminal_id.clone(),
                        title: notify::title(
                            task.subject.as_ref().map(|s| s.name.as_str()),
                            &task.title,
                        ),
                        body: n.body.clone(),
                    })
                })
                .collect()
        };
        Ok(Flush {
            changes,
            counts,
            notices,
        })
    }
}

/// Parents of the changed subtasks, with the instant of their child's change.
fn parents_of(
    conn: &Connection,
    dirty: &BTreeMap<String, String>,
) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT parent_id FROM tasks WHERE id = ?1")?;
    let mut parents = Vec::new();
    for (id, at) in dirty {
        let parent: Option<Option<String>> = stmt.query_row([id], |r| r.get(0)).optional()?;
        if let Some(Some(parent)) = parent {
            parents.push((parent, at.clone()));
        }
    }
    Ok(parents)
}

/// What a hook changes in the context gauge: `None` nothing, `Some(None)` forget it (a
/// compaction emptied the context; the next reply measures it again), `Some(usage)` the
/// usage read from the transcript after a reply or a tool.
fn context_update(name: &str, hook: &payload::Hook) -> Option<Option<ContextUsage>> {
    match (name, &hook.event) {
        ("SessionStart", Some(Event::SessionStart { source, .. }))
            if source.as_deref() == Some("compact") =>
        {
            Some(None)
        }
        (
            "SessionStart" | "Stop" | "StopFailure" | "PostToolUse" | "PostToolUseFailure"
            | "Interrupt",
            _,
        ) => {
            let path = hook.transcript_path.as_deref()?;
            // An unreadable transcript keeps the last known usage.
            usage::read(Path::new(path), hook.model.as_deref()).map(Some)
        }
        _ => None,
    }
}

/// Batching thread: after a wake-up, waits for the window to collect the burst, then sends
/// one batch for every task changed meanwhile.
fn run_batches(inner: Weak<Inner>, wake: Receiver<()>, sink: FlushSink, window: Duration) {
    while wake.recv().is_ok() {
        std::thread::sleep(window);
        while wake.try_recv().is_ok() {}
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let dirty = match inner.dirty.lock() {
            Ok(mut dirty) => std::mem::take(&mut *dirty),
            Err(e) => {
                log::warn!("task state batch poisoned: {e}");
                continue;
            }
        };
        // Taken after the tasks: a notice always comes with its task's change.
        let pending = match inner.notices.lock() {
            Ok(mut notices) => std::mem::take(&mut *notices),
            Err(e) => {
                log::warn!("notice queue poisoned: {e}");
                Vec::new()
            }
        };
        if dirty.is_empty() && pending.is_empty() {
            continue;
        }
        let batch = inner.batch(&dirty, &pending);
        drop(inner);
        match batch {
            Ok(flush) if !flush.changes.is_empty() => sink(flush),
            Ok(_) => {}
            Err(e) => log::warn!("cannot compute task states: {e}"),
        }
    }
}

#[cfg(test)]
mod tests;
