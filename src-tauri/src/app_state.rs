//! Shared state managed by Tauri.

use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::ask::run::Asks;
use crate::notify::Notifier;
use crate::session_service::SessionService;
use crate::summarizer::Summarizer;
use crate::sync::service::SyncService;
use crate::terminal_service::TerminalService;

pub struct AppState {
    /// Single connection behind a mutex: keep transactions short. Shared with the
    /// session service's threads (hooks, timers, batches).
    pub db: Arc<Mutex<Connection>>,
    /// Terminals and Claude Code launches.
    pub terminals: TerminalService,
    /// Claude session states: hooks, timers, exits, batched events.
    pub sessions: Arc<SessionService>,
    /// Port of the hook server on 127.0.0.1 (Réglages › Diagnostic).
    pub hooks_port: u16,
    /// One-line recaps of ended sessions by Claude Haiku (option 4).
    pub summarizer: Arc<Summarizer>,
    /// Sync with the server: worker, timers, link.
    pub sync: Arc<SyncService>,
    /// System notifications: knows the window's focus and the open task.
    pub notifier: Arc<Notifier>,
    /// Questions to a project running now (« Demander au projet »).
    pub asks: Arc<Asks>,
}
