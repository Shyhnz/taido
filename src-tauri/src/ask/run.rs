//! Running questions: one agent process per question, its JSON lines read as they come,
//! stopped by the user or after [`TIMEOUT`]. The registry also tells the MCP server which
//! project a question may read (`X-Ask-Id`).

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::error::{AppError, AppResult};
use crate::model::Agent;

use super::stream::{self, Line};
use super::{AskStep, AskUpdate, RawAnswer, Scope};

/// Longest wait for an answer.
pub const TIMEOUT: Duration = Duration::from_secs(180);
/// Bytes of the agent's error output kept for the logs.
const STDERR_KEEP: usize = 4096;

/// Sends one update of a question to the UI.
pub type Emit = Arc<dyn Fn(AskUpdate) + Send + Sync>;

/// One question to run.
pub struct Launch {
    pub ask_id: String,
    pub thread_id: String,
    pub question: String,
    pub agent: Agent,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    /// Written on the agent's standard input.
    pub input: String,
    pub scope: Arc<Scope>,
    pub timeout: Duration,
}

struct Running {
    scope: Arc<Scope>,
    emit: Emit,
    child: Arc<Mutex<Option<Child>>>,
    stopped: Arc<AtomicBool>,
}

/// The questions running now, and the project Claude terminals (`super::terminal`).
#[derive(Default)]
pub struct Asks {
    running: Mutex<HashMap<String, Running>>,
    /// Terminal id → the project its Claude may read (`X-Ask-Id` is the terminal id).
    terminals: Mutex<HashMap<String, Arc<Scope>>>,
}

impl Asks {
    /// The project a running question or project terminal may read, and where its steps go
    /// (nowhere for a terminal: Claude shows them itself).
    pub fn get(&self, ask_id: &str) -> Option<(Arc<Scope>, Emit)> {
        if let Some(r) = self.running.lock().ok()?.get(ask_id) {
            return Some((r.scope.clone(), r.emit.clone()));
        }
        let scope = self.terminals.lock().ok()?.get(ask_id).cloned()?;
        let silent: Emit = Arc::new(|_| {});
        Some((scope, silent))
    }

    /// A project terminal opened: its Claude may read `scope` until it is forgotten.
    pub fn add_terminal(&self, terminal_id: &str, scope: Arc<Scope>) {
        if let Ok(mut t) = self.terminals.lock() {
            t.insert(terminal_id.to_string(), scope);
        }
    }

    /// A project terminal closed or exited: its tools refuse from now on.
    pub fn forget_terminal(&self, terminal_id: &str) {
        if let Ok(mut t) = self.terminals.lock() {
            t.remove(terminal_id);
        }
    }

    /// A question about this project is running.
    pub fn busy(&self, subject_id: &str) -> bool {
        self.running
            .lock()
            .map(|r| r.values().any(|q| q.scope.subject_id == subject_id))
            .unwrap_or(false)
    }

    /// Stops a question: its process is killed, nothing is stored.
    pub fn stop(&self, ask_id: &str) {
        let Ok(running) = self.running.lock() else {
            return;
        };
        if let Some(r) = running.get(ask_id) {
            r.stopped.store(true, Ordering::SeqCst);
            kill(&r.child);
        }
    }

    /// Stops every question (app quitting).
    pub fn stop_all(&self) {
        let ids: Vec<String> = self
            .running
            .lock()
            .map(|r| r.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.stop(&id);
        }
    }

    /// Starts the agent and returns at once; updates go to `emit` from a background thread,
    /// the last one being `Answer`, `Failed` or `Stopped`.
    pub fn start(
        self: &Arc<Self>,
        launch: Launch,
        db: Arc<Mutex<Connection>>,
        emit: Emit,
    ) -> AppResult<()> {
        let child = Arc::new(Mutex::new(None));
        let stopped = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock()?;
            if running
                .values()
                .any(|q| q.scope.subject_id == launch.scope.subject_id)
            {
                return Err(AppError::Invalid(
                    "a question about this project is already running".into(),
                ));
            }
            running.insert(
                launch.ask_id.clone(),
                Running {
                    scope: launch.scope.clone(),
                    emit: emit.clone(),
                    child: child.clone(),
                    stopped: stopped.clone(),
                },
            );
        }
        let asks = self.clone();
        let id = launch.ask_id.clone();
        let spawned = std::thread::Builder::new()
            .name("ask".into())
            .spawn(move || {
                let ask_id = launch.ask_id.clone();
                let update = run(&launch, &db, &child, &stopped, &emit);
                if let Ok(mut running) = asks.running.lock() {
                    running.remove(&ask_id);
                }
                emit(update);
            });
        if let Err(e) = spawned {
            if let Ok(mut running) = self.running.lock() {
                running.remove(&id);
            }
            return Err(AppError::Internal(format!(
                "cannot start the question: {e}"
            )));
        }
        Ok(())
    }
}

/// Kills the agent and what it started (Codex's shell commands): on Unix the whole process
/// group, which keeps the output pipe open otherwise; on Windows its process tree.
fn kill(child: &Mutex<Option<Child>>) {
    if let Ok(mut c) = child.lock() {
        if let Some(c) = c.as_mut() {
            #[cfg(unix)]
            if let Ok(pid) = i32::try_from(c.id()) {
                // SAFETY: plain syscall on the group this child leads (`process_group(0)`).
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
            // Windows: the tree, as `taskkill /T` (Codex's shell commands, node under a shim).
            #[cfg(windows)]
            crate::env::kill_tree(c.id());
            let _ = c.kill();
        }
    }
}

/// Runs the agent to its end; the final update.
fn run(
    l: &Launch,
    db: &Mutex<Connection>,
    child_slot: &Arc<Mutex<Option<Child>>>,
    stopped: &AtomicBool,
    emit: &Emit,
) -> AskUpdate {
    // Windows: an npm shim runs its script with node (`agents::launch_command`).
    let (program, args) =
        match crate::agents::launch_command(&l.program.to_string_lossy(), &l.args, &l.env) {
            Ok(launch) => launch,
            Err(e) => {
                log::warn!("ask: cannot run {}: {e}", l.program.display());
                return AskUpdate::Failed {
                    message: Some(e.to_string()),
                    timed_out: false,
                };
            }
        };
    let mut command = Command::new(program);
    crate::env::hide_console(&mut command)
        .args(&args)
        .env_clear()
        .envs(&l.env)
        .current_dir(&l.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("ask: cannot run {}: {e}", l.program.display());
            return AskUpdate::Failed {
                message: Some(e.to_string()),
                timed_out: false,
            };
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let input = l.input.clone();
        // Detached: a full pipe must not block the reading below.
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Ok(mut slot) = child_slot.lock() {
        *slot = Some(child);
    }
    let err_text = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut stderr) = stderr {
        let keep = err_text.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut k) = keep.lock() {
                    k.extend_from_slice(&buf[..n]);
                    let excess = k.len().saturating_sub(STDERR_KEEP);
                    k.drain(..excess);
                }
            }
        });
    }
    // Watchdog: kills the process past the deadline.
    let done = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (done, timed_out, slot) = (done.clone(), timed_out.clone(), child_slot.clone());
        let deadline = Instant::now() + l.timeout;
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                if Instant::now() >= deadline {
                    timed_out.store(true, Ordering::SeqCst);
                    kill(&slot);
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
    }
    let mut answer: Option<RawAnswer> = None;
    let mut failure: Option<String> = None;
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            match stream::parse(l.agent, &line) {
                Line::Step(step) => emit(AskUpdate::Step {
                    step: relative(&l.scope, step),
                }),
                Line::Answer(a) => answer = Some(a),
                Line::Failed(m) => failure = Some(m),
                Line::Other => {}
            }
        }
    }
    // Output closed: the process is ending. Waited for outside the lock (`stop` takes it).
    let ended = child_slot.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut c) = ended {
        let _ = c.wait();
    }
    done.store(true, Ordering::SeqCst);
    if stopped.load(Ordering::SeqCst) {
        return AskUpdate::Stopped;
    }
    let timed_out = timed_out.load(Ordering::SeqCst);
    if let (Some(a), false) = (answer, timed_out) {
        let stored = db
            .lock()
            .map_err(AppError::from)
            .and_then(|conn| super::store(&conn, &l.scope, &l.thread_id, l.agent, &l.question, &a));
        match stored {
            Ok(Some(entry)) => return AskUpdate::Answer { entry },
            Ok(None) => {}
            Err(e) => {
                log::warn!("ask: cannot store the answer: {e}");
                return AskUpdate::Failed {
                    message: Some(e.to_string()),
                    timed_out: false,
                };
            }
        }
    }
    let stderr = err_text
        .lock()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .unwrap_or_default();
    log::info!(
        "ask {}: no answer (timed out: {timed_out}, failure: {failure:?}, stderr: {stderr})",
        l.ask_id
    );
    AskUpdate::Failed {
        message: failure.or((!stderr.is_empty()).then_some(stderr)),
        timed_out,
    }
}

fn relative(scope: &Scope, step: AskStep) -> AskStep {
    match step {
        AskStep::ReadFile { path } => AskStep::ReadFile {
            path: super::shown_path(scope, &path),
        },
        other => other,
    }
}
