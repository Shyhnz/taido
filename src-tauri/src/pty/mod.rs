//! PTY manager: one entry per terminal, its process in a pseudo-terminal, a
//! circular output buffer and at most one subscriber (the UI's xterm instance).
//!
//! Threads per terminal: a reader (blocking reads up to 64 KiB), a batcher (coalesces output
//! every ~16 ms or 32 KiB, appends it to the buffer and forwards it to the subscriber, under
//! the same lock as `attach`, so a subscriber gets neither gap nor duplicate) and a waiter
//! (reports the exit). The manager knows nothing of the database or of Tauri: the exit is
//! reported through a callback and the subscriber is a byte sink.

mod ring;

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::error::{AppError, AppResult};
use crate::model::{TerminalInfo, TerminalSize};
use ring::Ring;

const READ_CHUNK: usize = 64 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_BYTES: usize = 32 * 1024;
/// Default buffer per terminal.
pub const DEFAULT_BUFFER_BYTES: usize = 2 * 1024 * 1024;
/// SIGTERM, then SIGKILL after this delay.
#[cfg(unix)]
const KILL_GRACE: Duration = Duration::from_secs(3);

/// Receives output bytes; returns `false` when the subscriber is gone (it is then dropped).
pub type Sink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;

/// Called from the waiter thread once a process has exited, with the terminal's final info
/// (`running: false`, `exit_code: None` when killed by a signal).
pub type ExitHook = Arc<dyn Fn(&TerminalInfo) + Send + Sync>;

/// What to run (argument array, never a shell string built from user text).
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Full environment of the process (the parent's is not inherited).
    pub env: BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

struct Output {
    ring: Ring,
    subscriber: Option<Sink>,
}

struct Term {
    info: Mutex<TerminalInfo>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    size: Mutex<TerminalSize>,
    out: Mutex<Output>,
    pid: Option<u32>,
}

impl Term {
    fn running(&self) -> bool {
        self.info.lock().map(|i| i.running).unwrap_or(false)
    }
}

pub struct PtyManager {
    terms: Mutex<HashMap<String, Arc<Term>>>,
    buffer_bytes: usize,
    on_exit: ExitHook,
}

fn pty_err(e: impl std::fmt::Display) -> AppError {
    AppError::Internal(format!("pty: {e}"))
}

impl PtyManager {
    pub fn new(buffer_bytes: usize, on_exit: ExitHook) -> Self {
        PtyManager {
            terms: Mutex::new(HashMap::new()),
            buffer_bytes,
            on_exit,
        }
    }

    /// Spawns the process and starts streaming. `info.running` must be true.
    pub fn spawn(&self, info: TerminalInfo, spec: SpawnSpec) -> AppResult<()> {
        let size = PtySize {
            rows: spec.rows.max(1),
            cols: spec.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system().openpty(size).map_err(pty_err)?;
        // Windows: an npm shim (`codex.cmd`) runs its script with node, never through cmd.exe.
        let (program, args) = crate::agents::launch_command(&spec.program, &spec.args, &spec.env);
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        cmd.cwd(&spec.cwd);
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(pty_err)?;
        drop(pair.slave);
        let io = pair
            .master
            .try_clone_reader()
            .and_then(|r| Ok((r, pair.master.take_writer()?)));
        let (reader, writer) = match io {
            Ok(io) => io,
            Err(e) => {
                // Never leave a process nobody tracks.
                let _ = child.kill();
                let _ = child.wait();
                return Err(pty_err(e));
            }
        };
        let id = info.id.clone();
        let term = Arc::new(Term {
            info: Mutex::new(info),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            size: Mutex::new(TerminalSize {
                cols: size.cols,
                rows: size.rows,
            }),
            out: Mutex::new(Output {
                ring: Ring::new(self.buffer_bytes),
                subscriber: None,
            }),
            pid: child.process_id(),
        });
        self.terms.lock()?.insert(id.clone(), term.clone());

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        spawn_thread(&format!("pty-read-{id}"), move || read_loop(reader, tx));
        let batch_term = term.clone();
        spawn_thread(&format!("pty-batch-{id}"), move || {
            batch_loop(rx, &batch_term)
        });
        let on_exit = self.on_exit.clone();
        spawn_thread(&format!("pty-wait-{id}"), move || {
            let code = match child.wait() {
                Ok(status) if status.signal().is_none() => Some(status.exit_code() as i32),
                Ok(_) => None,
                Err(e) => {
                    log::warn!("waiting for terminal {} failed: {e}", term_id(&term));
                    None
                }
            };
            let info = match term.info.lock() {
                Ok(mut info) => {
                    info.running = false;
                    info.exit_code = code;
                    info.clone()
                }
                Err(_) => return,
            };
            on_exit(&info);
        });
        Ok(())
    }

    fn get(&self, id: &str) -> AppResult<Arc<Term>> {
        self.terms
            .lock()?
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))
    }

    /// Sends the buffered output to `sink`, then makes it the subscriber (replacing any
    /// previous one: a reloaded webview attaches again).
    pub fn attach(&self, id: &str, mut sink: Sink) -> AppResult<TerminalSize> {
        let term = self.get(id)?;
        let size = *term.size.lock()?;
        let mut out = term.out.lock()?;
        let snapshot = out.ring.snapshot();
        if !snapshot.is_empty() && !sink(snapshot) {
            out.subscriber = None;
            return Ok(size);
        }
        out.subscriber = Some(sink);
        Ok(size)
    }

    /// Stops streaming; the buffer keeps filling.
    pub fn detach(&self, id: &str) -> AppResult<()> {
        let term = self.get(id)?;
        term.out.lock()?.subscriber = None;
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        let term = self.get(id)?;
        if !term.running() {
            return Ok(());
        }
        let mut writer = term.writer.lock()?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let term = self.get(id)?;
        let size = TerminalSize {
            cols: cols.max(1),
            rows: rows.max(1),
        };
        *term.size.lock()? = size;
        if !term.running() {
            return Ok(());
        }
        let master = term.master.lock()?;
        let resized = master.resize(PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        resized.map_err(pty_err)
    }

    /// The terminal now runs another Claude conversation (`/clear`, `/resume` in Claude), or
    /// none any more (its conversation was resumed in another tab).
    pub fn set_agent_session(&self, id: &str, agent_session_id: Option<&str>) {
        let term = self.terms.lock().ok().and_then(|m| m.get(id).cloned());
        if let Some(term) = term {
            if let Ok(mut info) = term.info.lock() {
                info.agent_session_id = agent_session_id.map(str::to_string);
            }
        }
    }

    pub fn info(&self, id: &str) -> Option<TerminalInfo> {
        let term = self.terms.lock().ok()?.get(id).cloned()?;
        let info = term.info.lock().ok()?.clone();
        Some(info)
    }

    /// Every terminal, oldest first.
    pub fn list(&self) -> Vec<TerminalInfo> {
        let terms: Vec<Arc<Term>> = match self.terms.lock() {
            Ok(map) => map.values().cloned().collect(),
            Err(_) => return Vec::new(),
        };
        let mut list: Vec<TerminalInfo> = terms
            .iter()
            .filter_map(|t| t.info.lock().ok().map(|i| i.clone()))
            .collect();
        list.sort_by(|a, b| a.opened_at.cmp(&b.opened_at).then(a.id.cmp(&b.id)));
        list
    }

    pub fn for_task(&self, task_id: &str) -> Vec<TerminalInfo> {
        self.list()
            .into_iter()
            .filter(|t| t.task_id == task_id)
            .collect()
    }

    /// Forgets the terminal. A running process is stopped on a background thread (SIGTERM to
    /// its process group, SIGKILL after 3 s); its exit is still reported through the hook.
    pub fn remove(&self, id: &str) -> Option<TerminalInfo> {
        let term = self.terms.lock().ok()?.remove(id)?;
        // Output flushed after this point must not reach the UI's (disposed) instance.
        if let Ok(mut out) = term.out.lock() {
            out.subscriber = None;
        }
        let info = term.info.lock().ok()?.clone();
        if info.running {
            spawn_thread(&format!("pty-kill-{id}"), move || {
                stop_all(&[term]);
            });
        }
        Some(info)
    }

    /// Stops every running process and waits (SIGTERM to all, then one shared 3 s grace
    /// period, then SIGKILL): used when the app quits, so no process outlives it.
    pub fn shutdown_all(&self) {
        let terms: Vec<Arc<Term>> = match self.terms.lock() {
            Ok(mut map) => map.drain().map(|(_, t)| t).collect(),
            Err(_) => return,
        };
        let running: Vec<Arc<Term>> = terms.into_iter().filter(|t| t.running()).collect();
        stop_all(&running);
    }
}

fn term_id(term: &Term) -> String {
    term.info.lock().map(|i| i.id.clone()).unwrap_or_default()
}

fn spawn_thread(name: &str, f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new().name(name.to_string()).spawn(f) {
        log::error!("cannot start thread {name}: {e}");
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        }
    }
}

/// Coalesces chunks (fewer, larger IPC messages) and appends them to the buffer.
fn batch_loop(rx: mpsc::Receiver<Vec<u8>>, term: &Term) {
    let mut pending: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut last_flush = Instant::now();
    loop {
        let timeout = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
        let disconnected = match rx.recv_timeout(timeout) {
            Ok(chunk) => {
                pending.extend_from_slice(&chunk);
                if pending.len() < FLUSH_BYTES && last_flush.elapsed() < FLUSH_INTERVAL {
                    continue;
                }
                false
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => true,
        };
        if !pending.is_empty() {
            let bytes = std::mem::replace(&mut pending, Vec::with_capacity(FLUSH_BYTES));
            if let Ok(mut out) = term.out.lock() {
                out.ring.push(&bytes);
                if let Some(sink) = out.subscriber.as_mut() {
                    if !sink(bytes) {
                        out.subscriber = None;
                    }
                }
            }
        }
        if disconnected {
            break;
        }
        last_flush = Instant::now();
    }
}

/// Stops every terminal's whole session: SIGHUP and SIGTERM to every process of
/// each session, one shared grace period for the session leaders, then SIGKILL to whatever is
/// left in those sessions.
///
/// Signalling the leader's process group is not enough: an interactive shell puts each job in
/// its own process group and ignores SIGTERM, so `sleep 300 &` would survive. Every process
/// started in the terminal keeps the session id of the leader (portable-pty calls `setsid`),
/// even once the leader is gone, so the session is what we sweep. A process that starts its
/// own session on purpose (a daemon) is left alone.
#[cfg(unix)]
fn stop_all(terms: &[Arc<Term>]) {
    let leaders: Vec<(Arc<Term>, libc::pid_t)> = terms
        .iter()
        .filter_map(|t| t.pid.map(|pid| (t.clone(), pid as libc::pid_t)))
        .collect();
    let sessions: Vec<libc::pid_t> = leaders.iter().map(|(_, pid)| *pid).collect();
    if sessions.is_empty() {
        return;
    }
    for pid in session_members(&sessions) {
        // SIGHUP: a shell hangs up its jobs; SIGTERM: everything else.
        signal(pid, libc::SIGHUP);
        signal(pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline && leaders.iter().any(|(t, _)| t.running()) {
        std::thread::sleep(Duration::from_millis(25));
    }
    for pid in session_members(&sessions) {
        signal(pid, libc::SIGKILL);
    }
}

/// Processes whose session id is one of `sessions` (leaders included).
#[cfg(unix)]
fn session_members(sessions: &[libc::pid_t]) -> Vec<libc::pid_t> {
    all_pids()
        .into_iter()
        .filter(|pid| {
            // SAFETY: getsid only reads the session id of a process; -1 if it is gone.
            let sid = unsafe { libc::getsid(*pid) };
            sid > 0 && sessions.contains(&sid)
        })
        .collect()
}

/// Every process id, from `ps` (macOS and Linux).
#[cfg(unix)]
fn all_pids() -> Vec<libc::pid_t> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .filter_map(|p| p.parse().ok())
            .collect(),
        Err(e) => {
            log::warn!("cannot list processes: {e}");
            Vec::new()
        }
    }
}

#[cfg(unix)]
fn signal(pid: libc::pid_t, signal: libc::c_int) {
    // SAFETY: kill only sends a signal to a process of the terminal's session.
    let rc = unsafe { libc::kill(pid, signal) };
    if rc != 0 {
        log::debug!(
            "kill({pid}, {signal}) failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// Windows: no sessions nor signals. Each terminal's process tree ends at once.
#[cfg(windows)]
fn stop_all(terms: &[Arc<Term>]) {
    for pid in terms.iter().filter_map(|t| t.pid) {
        crate::env::kill_tree(pid);
    }
}

// Unix only: POSIX shells, sessions and signals.
#[cfg(all(test, unix))]
mod tests;
#[cfg(all(test, windows))]
mod windows_tests;
