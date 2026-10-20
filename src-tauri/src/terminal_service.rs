//! Opening and closing terminals: the business rules between the database,
//! the PTY manager and the Claude Code launcher. Commands stay thin and call this service.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;

use crate::agents::claude::{self, NewSession, TaskContext};
use crate::agents::{claude_check, codex, codex_check};
use crate::db::agent_sessions::{is_pending_conversation, PENDING_PREFIX};
use crate::db::{self, agent_sessions, history, journal, settings, tasks, terminals as rows};
use crate::env::{self, ResolvedEnv};
use crate::error::{AppError, AppResult};
use crate::model::{
    Agent, AgentStatus, JournalKind, OpenTerminalInput, ResumeSessionInput, TaskDetail,
    TerminalInfo, TerminalKind, Workdir,
};
use crate::pty::{PtyManager, SpawnSpec};

/// Folder of the per-session context files, under the app data dir.
const CONTEXTS_DIR: &str = "contexts";
/// Hooks settings file, under the app data dir.
pub const HOOKS_FILE: &str = "claude-hooks.json";
/// MCP config file of the app's server, under the app data dir (`--mcp-config`).
pub const MCP_FILE: &str = "claude-mcp.json";

/// Development overrides of the agents' binaries, read once at startup:
/// `TAIDO_CLAUDE_BIN` → `fake-claude`, `TAIDO_CODEX_BIN` → `fake-codex`. They win
/// over the explicit settings, which are read at each launch.
#[derive(Debug, Clone, Default)]
pub struct AgentOverrides {
    pub claude: Option<String>,
    pub codex: Option<String>,
}

impl AgentOverrides {
    pub fn from_env() -> Self {
        AgentOverrides {
            claude: std::env::var(claude::CLAUDE_BIN_VAR).ok(),
            codex: std::env::var(codex::CODEX_BIN_VAR).ok(),
        }
    }
}

pub struct TerminalService {
    pub pty: PtyManager,
    /// Login-shell environment, resolved once (up to 3 s) in the background at startup.
    env: OnceLock<ResolvedEnv>,
    data_dir: PathBuf,
    hook_token: String,
    /// Port of the hook and MCP server (Codex gets it in its arguments and environment).
    hook_port: u16,
    overrides: AgentOverrides,
}

impl TerminalService {
    pub fn new(
        pty: PtyManager,
        data_dir: PathBuf,
        hook_token: String,
        hook_port: u16,
        overrides: AgentOverrides,
    ) -> Self {
        TerminalService {
            pty,
            env: OnceLock::new(),
            data_dir,
            hook_token,
            hook_port,
            overrides,
        }
    }

    #[cfg(test)]
    pub fn set_codex_override(&mut self, bin: Option<String>) {
        self.overrides.codex = bin;
    }

    /// The login-shell environment; blocks while it is being resolved (call off the main
    /// thread).
    pub fn env(&self) -> &ResolvedEnv {
        self.env.get_or_init(env::resolve)
    }

    /// Token of the hook server (sent back by the agents as `X-App-Token`).
    pub fn hook_token(&self) -> &str {
        &self.hook_token
    }

    pub fn hook_port(&self) -> u16 {
        self.hook_port
    }

    /// The app's data folder (`claude-mcp.json`, `ask-mcp.json`…).
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    pub fn hooks_file(&self) -> PathBuf {
        self.data_dir.join(HOOKS_FILE)
    }

    pub fn mcp_file(&self) -> PathBuf {
        self.data_dir.join(MCP_FILE)
    }

    /// The `claude` binary of a launch: the override, else the setting **as it is now**
    /// (changed in Réglages without restarting), else the automatic detection.
    /// `TAIDO_CLAUDE_BIN` points to a stand-in (`fake-claude` in development).
    /// A fake agent stands in (development): recaps would store its canned answers.
    pub fn uses_dev_override(&self) -> bool {
        self.overrides.claude.is_some() || self.overrides.codex.is_some()
    }

    /// The binary a launch of `agent` would use now, or `None` when it cannot be found.
    fn find_binary(
        &self,
        conn: &Connection,
        env: &BTreeMap<String, String>,
        agent: Agent,
    ) -> AppResult<Option<PathBuf>> {
        let s = settings::get(conn)?;
        Ok(match agent {
            Agent::Claude => claude::resolve_binary(
                self.overrides.claude.as_deref(),
                s.claude_path.as_deref(),
                env,
            ),
            Agent::Codex => crate::agents::resolve_binary(
                &codex::BINARY,
                self.overrides.codex.as_deref(),
                s.codex_path.as_deref(),
                env,
            ),
        })
    }

    /// The agents whose binary is found now (« + » menu of a task): no process is run, only the
    /// binary looked up like a launch. Blocking the first time (login shell): call it from
    /// `spawn_blocking`.
    pub fn installed_agents(&self, db: &Mutex<Connection>) -> AppResult<Vec<Agent>> {
        let env = self.env().vars.clone();
        let conn = db.lock()?;
        let mut found = Vec::new();
        for agent in [Agent::Claude, Agent::Codex] {
            if self.find_binary(&conn, &env, agent)?.is_some() {
                found.push(agent);
            }
        }
        Ok(found)
    }

    pub fn agent_binary(
        &self,
        conn: &Connection,
        env: &BTreeMap<String, String>,
        agent: Agent,
    ) -> AppResult<PathBuf> {
        self.find_binary(conn, env, agent)?.ok_or(match agent {
            Agent::Claude => AppError::ClaudeMissing,
            Agent::Codex => AppError::CodexMissing,
        })
    }

    /// Agent check (Réglages › Agents, first-launch guide, before the first launch): the
    /// binary a launch would use, its version and whether it is logged in, run in the
    /// terminals' environment. Blocking (login shell, then up to twice `timeout`): call it
    /// from `spawn_blocking`.
    pub fn check_agent(
        &self,
        db: &Mutex<Connection>,
        agent: Agent,
        timeout: std::time::Duration,
    ) -> AppResult<AgentStatus> {
        let env = self.env().vars.clone();
        let bin = self.find_binary(&*db.lock()?, &env, agent)?;
        Ok(match agent {
            Agent::Claude => claude_check::check(bin, &env, timeout),
            Agent::Codex => codex_check::check(bin, &env, timeout),
        })
    }

    /// Opens a terminal on a task. Blocking (environment, process spawn): call it from
    /// `spawn_blocking`.
    pub fn open(
        &self,
        db: &Mutex<Connection>,
        input: &OpenTerminalInput,
    ) -> AppResult<TerminalInfo> {
        let base_env = self.env().vars.clone();
        let terminal_id = db::new_id();
        let (info, spec) = {
            let conn = db.lock()?;
            let (info, spec, session) = self.prepare(&conn, input, &terminal_id, base_env)?;
            rows::insert(
                &conn,
                &rows::NewTerminal {
                    id: &info.id,
                    task_id: &info.task_id,
                    kind: info.kind,
                    command: info.command.as_deref(),
                    cwd: &info.cwd,
                    opened_at: &info.opened_at,
                },
                session
                    .as_ref()
                    .map(|s| rows::NewSession {
                        id: &s.id,
                        task_id: &info.task_id,
                        conversation_id: &s.conversation_id,
                        agent: s.agent,
                        terminal_id: &info.id,
                        permission_mode: input.permission_mode,
                        add_task_context: s.add_task_context,
                        at: &info.opened_at,
                    })
                    .as_ref(),
            )?;
            (info, spec)
        };
        if let Err(e) = self.pty.spawn(info.clone(), spec) {
            log::warn!("terminal {} could not start: {e}", info.id);
            if let Ok(conn) = db.lock() {
                if let Err(e) = rows::delete_unstarted(&conn, &info.id) {
                    log::warn!("cannot remove the rows of terminal {}: {e}", info.id);
                }
            }
            return Err(e);
        }
        Ok(info)
    }

    /// « Demander au projet » (`crate::ask::terminal`): the project's running Claude terminal,
    /// else a new one in its folder (an empty app folder without one). Refused without
    /// Claude (`claude_missing`). Blocking: call it from
    /// `spawn_blocking`.
    pub fn open_ask(
        &self,
        db: &Mutex<Connection>,
        asks: &crate::ask::run::Asks,
        subject_id: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<TerminalInfo> {
        use crate::ask::{self, terminal};
        let key = terminal::task_key(subject_id);
        if let Some(open) = self.pty.for_task(&key).into_iter().find(|t| t.running) {
            return Ok(open);
        }
        let mut env = self.env().vars.clone();
        let (scope, bin, lang) = {
            let conn = db.lock()?;
            let scope = ask::scope(&conn, subject_id)?;
            let bin = self.agent_binary(&conn, &env, Agent::Claude)?;
            (scope, bin, crate::i18n::current_language(&conn))
        };
        let cwd = match &scope.root {
            Some(root) => root.clone(),
            None => {
                let empty = self.data_dir.join("ask-empty");
                std::fs::create_dir_all(&empty)?;
                empty
            }
        };
        let terminal_id = db::new_id();
        terminal_env(&mut env, &terminal_id);
        env.insert("TAIDO_HOOK_TOKEN".into(), self.hook_token.clone());
        env.insert(ask::ASK_ID_VAR.into(), terminal_id.clone());
        let args = terminal::claude_args(
            &terminal::system_prompt(&scope, lang),
            &self.data_dir.join(ask::MCP_FILE),
            &terminal::session_name(&scope, lang),
        );
        let info = TerminalInfo {
            id: terminal_id.clone(),
            task_id: key,
            kind: TerminalKind::Agent,
            command: None,
            cwd: cwd.to_string_lossy().into_owned(),
            opened_at: db::now_utc(),
            running: true,
            exit_code: None,
            agent_session_id: None,
            agent: Some(Agent::Claude),
        };
        let spec = SpawnSpec {
            program: bin.to_string_lossy().into_owned(),
            args,
            cwd,
            env,
            cols,
            rows,
        };
        asks.add_terminal(&terminal_id, std::sync::Arc::new(scope));
        if let Err(e) = self.pty.spawn(info.clone(), spec) {
            asks.forget_terminal(&terminal_id);
            return Err(e);
        }
        Ok(info)
    }

    /// The folder of the task's attachments, given to Claude with `--add-dir` (it
    /// lies outside the working folder, in `~/Taido/Pièces jointes`).
    fn attachments_dir(detail: &TaskDetail) -> Option<PathBuf> {
        detail
            .attachments
            .iter()
            .filter(|a| a.exists)
            .find_map(|a| std::path::Path::new(&a.path).parent().map(PathBuf::from))
    }

    /// Checks the folder and builds what to run; writes the context file for Claude.
    fn prepare(
        &self,
        conn: &Connection,
        input: &OpenTerminalInput,
        terminal_id: &str,
        mut env: BTreeMap<String, String>,
    ) -> AppResult<(TerminalInfo, SpawnSpec, Option<SessionIds>)> {
        let detail = tasks::detail(conn, &input.task_id)?;
        let workdir = checked_workdir(&detail)?;
        terminal_env(&mut env, terminal_id);
        let shell = env::terminal_shell(&env);
        let mut session = None;
        let mut command = None;
        let (program, args) = match input.kind {
            TerminalKind::Shell => (shell, env::shell_args()),
            TerminalKind::Command => {
                let cmd = input
                    .command
                    .as_deref()
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                    .ok_or_else(|| AppError::Invalid("command must not be empty".into()))?;
                command = Some(cmd.to_string());
                // « Commande » terminals are explicitly shell commands.
                (shell, env::command_args(cmd))
            }
            TerminalKind::Agent => {
                let agent = match input.agent {
                    Some(agent) => agent,
                    None => settings::get(conn)?.default_agent,
                };
                let bin = self.agent_binary(conn, &env, agent)?;
                let new_uuid = uuid::Uuid::new_v4().to_string();
                let ids = SessionIds {
                    id: db::new_id(),
                    // Codex chooses its own id and announces it with its first hooks.
                    conversation_id: match agent {
                        Agent::Claude => new_uuid,
                        Agent::Codex => format!("{PENDING_PREFIX}{new_uuid}"),
                    },
                    agent,
                    add_task_context: input.add_task_context.unwrap_or(true),
                };
                let project = project_label(conn, &detail)?;
                let add_dir = Self::attachments_dir(&detail);
                let args = match agent {
                    Agent::Claude => {
                        let context_file = if ids.add_task_context {
                            Some(self.write_context(&detail, project.as_deref(), &ids.id)?)
                        } else {
                            None
                        };
                        let name = claude::session_name(project.as_deref(), &detail.title);
                        let settings = self.hooks_file();
                        let mcp_config = self.mcp_file();
                        claude::new_session_args(&NewSession {
                            session_id: &ids.conversation_id,
                            settings_file: &settings,
                            mcp_config_file: &mcp_config,
                            name: &name,
                            permission_mode: input.permission_mode,
                            context_file: context_file.as_deref(),
                            prompt: input.initial_prompt.as_deref(),
                            add_dir: add_dir.as_deref(),
                        })
                    }
                    Agent::Codex => {
                        let context = ids
                            .add_task_context
                            .then(|| context_of(&detail, project.as_deref()));
                        env.extend(codex::launch_env(self.hook_port));
                        codex::new_session_args(&codex::Launch {
                            port: self.hook_port,
                            context: context.as_deref(),
                            prompt: input.initial_prompt.as_deref(),
                        })
                    }
                };
                env.insert("TAIDO_HOOK_TOKEN".into(), self.hook_token.clone());
                session = Some(ids);
                (bin.to_string_lossy().into_owned(), args)
            }
        };
        let info = TerminalInfo {
            id: terminal_id.to_string(),
            task_id: detail.id.clone(),
            kind: input.kind,
            command,
            cwd: workdir.path.clone(),
            opened_at: db::now_utc(),
            running: true,
            exit_code: None,
            agent_session_id: session.as_ref().map(|s| s.id.clone()),
            agent: session.as_ref().map(|s| s.agent),
        };
        let spec = SpawnSpec {
            program,
            args,
            cwd: PathBuf::from(&workdir.path),
            env,
            cols: input.cols,
            rows: input.rows,
        };
        Ok((info, spec, session))
    }

    /// Writes `contexts/<agent_session_id>.md`, again at every launch and resume:
    /// the task may have changed meanwhile.
    fn write_context(
        &self,
        detail: &TaskDetail,
        project: Option<&str>,
        agent_session_id: &str,
    ) -> AppResult<PathBuf> {
        let path = self
            .data_dir
            .join(CONTEXTS_DIR)
            .join(format!("{agent_session_id}.md"));
        let text = context_of(detail, project);
        claude::write_private(&path, &text)?;
        Ok(path)
    }

    /// « Reprendre »: `claude --resume` in a new tab of the session's
    /// task, the session row reattached to it (Starting). Refused (`invalid`) while the
    /// conversation runs in a tab, or when it has no message (Claude keeps nothing of it). Blocking: call it from `spawn_blocking`.
    pub fn resume(
        &self,
        db: &Mutex<Connection>,
        input: &ResumeSessionInput,
    ) -> AppResult<TerminalInfo> {
        let mut env = self.env().vars.clone();
        let terminal_id = db::new_id();
        let (info, spec, before) = {
            let conn = db.lock()?;
            let row = agent_sessions::get(&conn, &input.agent_session_id)?;
            // Running in a tab, or still being launched (its row is open but the PTY manager
            // may not know it yet: two quick « Reprendre »).
            let running = match row.current_terminal_id.as_deref() {
                Some(t) => self.pty.info(t).is_some_and(|t| t.running) || rows::is_open(&conn, t)?,
                None => false,
            };
            if running {
                return Err(AppError::Invalid(format!(
                    "session {} already runs in a tab",
                    row.id
                )));
            }
            if history::prompt_count(&conn, &row.id)? == 0
                || is_pending_conversation(&row.session.conversation_id)
            {
                return Err(AppError::Invalid(format!(
                    "session {} has no message to resume",
                    row.id
                )));
            }
            let options = agent_sessions::launch_options(&conn, &row.id)?;
            let detail = tasks::detail(&conn, &row.task_id)?;
            // Claude finds a conversation under the folder it ran in: resume there while it
            // exists, else in the task's folder.
            let previous_cwd = match row.current_terminal_id.as_deref() {
                Some(t) => rows::cwd_of(&conn, t)?.filter(|c| Path::new(c).is_dir()),
                None => None,
            };
            let cwd = match previous_cwd {
                Some(c) => c,
                None => checked_workdir(&detail)?.path.clone(),
            };
            terminal_env(&mut env, &terminal_id);
            // Always the session's own agent, whatever the default is now.
            let bin = self.agent_binary(&conn, &env, row.agent)?;
            let project = project_label(&conn, &detail)?;
            let add_dir = Self::attachments_dir(&detail);
            let args = match row.agent {
                Agent::Claude => {
                    let context_file = if options.add_task_context {
                        Some(self.write_context(&detail, project.as_deref(), &row.id)?)
                    } else {
                        None
                    };
                    let settings = self.hooks_file();
                    let mcp_config = self.mcp_file();
                    claude::resume_args(&claude::Resume {
                        conversation_id: &row.session.conversation_id,
                        settings_file: &settings,
                        mcp_config_file: &mcp_config,
                        permission_mode: options.permission_mode,
                        context_file: context_file.as_deref(),
                        add_dir: add_dir.as_deref(),
                    })
                }
                Agent::Codex => {
                    let context = options
                        .add_task_context
                        .then(|| context_of(&detail, project.as_deref()));
                    env.extend(codex::launch_env(self.hook_port));
                    codex::resume_args(
                        &row.session.conversation_id,
                        &codex::Launch {
                            port: self.hook_port,
                            context: context.as_deref(),
                            prompt: None,
                        },
                    )
                }
            };
            env.insert("TAIDO_HOOK_TOKEN".into(), self.hook_token.clone());
            let info = TerminalInfo {
                id: terminal_id.clone(),
                task_id: detail.id.clone(),
                kind: TerminalKind::Agent,
                command: None,
                cwd: cwd.clone(),
                opened_at: db::now_utc(),
                running: true,
                exit_code: None,
                agent_session_id: Some(row.id.clone()),
                agent: Some(row.agent),
            };
            // `rows::insert` runs its own transaction; the reattachment follows in another.
            rows::insert(
                &conn,
                &rows::NewTerminal {
                    id: &info.id,
                    task_id: &info.task_id,
                    kind: info.kind,
                    command: None,
                    cwd: &info.cwd,
                    opened_at: &info.opened_at,
                },
                None,
            )?;
            let before = agent_sessions::attach_resumed(
                &conn,
                &row.id,
                &info.id,
                &info.task_id,
                &info.opened_at,
            )?;
            let spec = SpawnSpec {
                program: bin.to_string_lossy().into_owned(),
                args,
                cwd: PathBuf::from(&cwd),
                env,
                cols: input.cols,
                rows: input.rows,
            };
            (info, spec, before)
        };
        if let Err(e) = self.pty.spawn(info.clone(), spec) {
            log::warn!("resumed terminal {} could not start: {e}", info.id);
            if let Ok(conn) = db.lock() {
                if let Err(e) = agent_sessions::detach_failed_resume(&conn, &info.id, &before) {
                    log::warn!("cannot undo the resume in terminal {}: {e}", info.id);
                }
            }
            return Err(e);
        }
        // The old tab (kept with its « Terminé ») no longer shows this conversation.
        if let Some(old) = before.terminal_id.as_deref() {
            self.pty.set_agent_session(old, None);
        }
        let conn = db.lock()?;
        journal::add_for_session(&conn, &info.task_id, &before.id, JournalKind::Resumed, "")?;
        Ok(info)
    }

    /// Closes a terminal: marked closed by the user **before** its process is stopped
    ///, then forgotten. Unknown terminals are ignored (already closed).
    pub fn close(
        &self,
        db: &Mutex<Connection>,
        terminal_id: &str,
    ) -> AppResult<Option<TerminalInfo>> {
        let Some(info) = self.pty.info(terminal_id) else {
            return Ok(None);
        };
        if info.running {
            rows::mark_closed_by_user(&*db.lock()?, terminal_id)?;
        } else if info.agent_session_id.is_some() {
            // Closing the tab of a crashed Claude ends its « ! ».
            rows::settle_crashed_tab(&*db.lock()?, terminal_id)?;
        }
        Ok(self.pty.remove(terminal_id))
    }

    /// Closes every terminal of the given tasks (completion, deletion). Returns the
    /// tasks that had some.
    pub fn close_for_tasks(&self, db: &Mutex<Connection>, task_ids: &[String]) -> Vec<String> {
        let mut touched = Vec::new();
        for t in self.pty.list() {
            if !task_ids.contains(&t.task_id) {
                continue;
            }
            if let Err(e) = self.close(db, &t.id) {
                log::warn!("cannot close terminal {}: {e}", t.id);
            }
            if !touched.contains(&t.task_id) {
                touched.push(t.task_id.clone());
            }
        }
        touched
    }

    /// Tasks of the terminals kept in memory (to find those of a deleted project); project
    /// terminals (`crate::ask::terminal`) are not tasks' and are left out.
    pub fn task_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .pty
            .list()
            .into_iter()
            .map(|t| t.task_id)
            .filter(|id| crate::ask::terminal::subject_of(id).is_none())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Project terminals (`crate::ask::terminal`) kept in memory: (terminal id, project id).
    pub fn ask_terminals(&self) -> Vec<(String, String)> {
        self.pty
            .list()
            .into_iter()
            .filter_map(|t| {
                crate::ask::terminal::subject_of(&t.task_id).map(|s| (t.id.clone(), s.to_string()))
            })
            .collect()
    }

    /// ⌘Q / app exit: sessions paused and terminals marked closed by the user,
    /// then every process stopped. Blocking, up to ~3 s. Safe to call twice.
    pub fn shutdown(&self, db: &Mutex<Connection>) {
        match db.lock() {
            Ok(conn) => match rows::pause_all_open(&conn) {
                Ok(n) if n > 0 => log::info!("paused {n} open terminals before quitting"),
                Ok(_) => {}
                Err(e) => log::warn!("cannot pause terminals before quitting: {e}"),
            },
            Err(e) => log::warn!("cannot pause terminals, database lock poisoned: {e}"),
        }
        self.pty.shutdown_all();
    }
}

/// Task context given to the agent: Claude reads it from a file, Codex from its
/// instructions.
fn context_of(detail: &TaskDetail, project: Option<&str>) -> String {
    let subtasks = detail
        .subtasks
        .iter()
        .map(|s| (s.done, s.text.as_str()))
        .collect();
    let attachments: Vec<String> = detail
        .attachments
        .iter()
        .filter(|a| a.exists)
        .map(|a| a.path.clone())
        .collect();
    claude::context_text(&TaskContext {
        subject: project,
        parent: detail.parent.as_ref().map(|p| p.title.as_str()),
        title: &detail.title,
        description: &detail.description,
        subtasks,
        attachments: &attachments,
    })
}

/// The task's working folder, which must exist.
fn checked_workdir(detail: &TaskDetail) -> AppResult<&Workdir> {
    let workdir = detail
        .workdir
        .as_ref()
        .ok_or_else(|| AppError::NoFolder(detail.id.clone()))?;
    if !Path::new(&workdir.path).is_dir() {
        return Err(AppError::FolderMissing(workdir.path.clone()));
    }
    Ok(workdir)
}

/// « Globex › Client » for a sub-project, else the project's name (context file, `--name`).
fn project_label(conn: &Connection, detail: &TaskDetail) -> AppResult<Option<String>> {
    let Some(tag) = &detail.subject else {
        return Ok(None);
    };
    Ok(Some(crate::db::subjects::label(conn, &tag.id)?))
}

/// Variables every terminal gets.
fn terminal_env(env: &mut BTreeMap<String, String>, terminal_id: &str) {
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env.insert("TAIDO_TERMINAL_ID".into(), terminal_id.into());
    if !env.contains_key("LANG") && !env.contains_key("LC_ALL") {
        env.insert("LANG".into(), "en_US.UTF-8".into());
    }
}

struct SessionIds {
    id: String,
    conversation_id: String,
    agent: Agent,
    add_task_context: bool,
}

#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod tests;
