//! Claude Code launch: binary detection, command-line arguments, the task
//! context file, the hooks settings file and the MCP config file. Pure functions except the
//! file writers.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::BinarySpec;
use crate::i18n::{self, Language};
use crate::model::PermissionMode;

/// Development override pointing to `fake-claude`.
pub const CLAUDE_BIN_VAR: &str = "TAIDO_CLAUDE_BIN";
/// Name shown in the context file and the permission status message (D9: « Todo »).
const APP_NAME: &str = "Taido";
/// Description length kept in the context file.
const DESCRIPTION_MAX_CHARS: usize = 2000;

/// Usual install locations on macOS, after the `PATH` of the login shell.
const COMMON_LOCATIONS: &[&str] = &[
    "~/.claude/local/claude",
    "~/.local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
];

pub const BINARY: BinarySpec = BinarySpec {
    name: "claude",
    common_locations: COMMON_LOCATIONS,
    // The native installer's `claude.exe`, then npm's `claude.cmd`.
    windows_dirs: &[&[".local", "bin"], super::WINDOWS_NPM_DIR],
};

/// The `claude` binary to run (see [`super::resolve_binary`]).
pub fn resolve_binary(
    override_bin: Option<&str>,
    setting: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    super::resolve_binary(&BINARY, override_bin, setting, env)
}

/// `--name`: « Projet · Titre », or the title alone for a task without project.
pub fn session_name(subject: Option<&str>, title: &str) -> String {
    match subject {
        Some(s) => format!("{s} · {title}"),
        None => title.to_string(),
    }
}

/// Task data written to the context file.
pub struct TaskContext<'a> {
    pub subject: Option<&'a str>,
    /// Title of the parent task, for a subtask.
    pub parent: Option<&'a str>,
    pub title: &'a str,
    pub description: &'a str,
    /// (done, text)
    pub subtasks: Vec<(bool, &'a str)>,
    /// Absolute paths of the task's attachments.
    pub attachments: &'a [String],
}

/// Content of `contexts/<agent_session_id>.md`.
pub fn context_text(ctx: &TaskContext<'_>) -> String {
    let mut out = format!("Context provided by {APP_NAME}:\n");
    if let Some(subject) = ctx.subject {
        out.push_str(&format!("- Project: {subject}\n"));
    }
    if let Some(parent) = ctx.parent {
        out.push_str(&format!("- Subtask of: {parent}\n"));
    }
    out.push_str(&format!("- Task: {}\n", ctx.title));
    let description = ctx.description.trim();
    if !description.is_empty() {
        let truncated: String = description.chars().take(DESCRIPTION_MAX_CHARS).collect();
        let ellipsis = if description.chars().count() > DESCRIPTION_MAX_CHARS {
            "…"
        } else {
            ""
        };
        out.push_str(&format!("- Description: {truncated}{ellipsis}\n"));
    }
    if !ctx.subtasks.is_empty() {
        out.push_str("- Subtasks:\n");
        for (done, text) in &ctx.subtasks {
            let mark = if *done { "x" } else { " " };
            out.push_str(&format!("  - [{mark}] {text}\n"));
        }
    }
    if !ctx.attachments.is_empty() {
        out.push_str("- Attachments (readable):\n");
        for path in ctx.attachments {
            out.push_str(&format!("  - {path}\n"));
        }
    }
    out
}

/// Arguments of a new Claude Code session, as an array: no shell involved.
pub struct NewSession<'a> {
    pub session_id: &'a str,
    pub settings_file: &'a Path,
    /// `claude-mcp.json`: the app's MCP server (`crate::mcp`).
    pub mcp_config_file: &'a Path,
    pub name: &'a str,
    pub permission_mode: Option<PermissionMode>,
    pub context_file: Option<&'a Path>,
    pub prompt: Option<&'a str>,
    /// The task's attachments folder, readable by Claude (`--add-dir`).
    pub add_dir: Option<&'a Path>,
}

pub fn new_session_args(s: &NewSession<'_>) -> Vec<String> {
    let mut args = vec![
        "--session-id".to_string(),
        s.session_id.to_string(),
        "--settings".to_string(),
        s.settings_file.to_string_lossy().into_owned(),
        // Variadic in Claude Code (`<configs...>`): always followed by another option.
        "--mcp-config".to_string(),
        s.mcp_config_file.to_string_lossy().into_owned(),
    ];
    // Variadic too (`<directories...>`): followed by `--name`.
    if let Some(dir) = s.add_dir {
        args.push("--add-dir".into());
        args.push(dir.to_string_lossy().into_owned());
    }
    args.push("--name".into());
    args.push(s.name.to_string());
    if let Some(mode) = s.permission_mode.and_then(PermissionMode::as_cli) {
        args.push("--permission-mode".into());
        args.push(mode.into());
    }
    if let Some(file) = s.context_file {
        args.push("--append-system-prompt-file".into());
        args.push(file.to_string_lossy().into_owned());
    }
    if let Some(prompt) = s.prompt.map(str::trim).filter(|p| !p.is_empty()) {
        // A prompt starting with "-" would be read as an option: a leading space keeps it a
        // positional argument.
        if prompt.starts_with('-') {
            args.push(format!(" {prompt}"));
        } else {
            args.push(prompt.to_string());
        }
    }
    args
}

/// Arguments of a resumed conversation: `--settings` is not restored by Claude
/// Code, so it is always passed again, like the mode and the context file.
pub struct Resume<'a> {
    pub conversation_id: &'a str,
    pub settings_file: &'a Path,
    /// `claude-mcp.json`: the app's MCP server (`crate::mcp`).
    pub mcp_config_file: &'a Path,
    pub permission_mode: Option<PermissionMode>,
    pub context_file: Option<&'a Path>,
    /// The task's attachments folder (`--add-dir`).
    pub add_dir: Option<&'a Path>,
}

pub fn resume_args(r: &Resume<'_>) -> Vec<String> {
    let mut args = vec![
        "--resume".to_string(),
        r.conversation_id.to_string(),
        "--settings".to_string(),
        r.settings_file.to_string_lossy().into_owned(),
        // Variadic in Claude Code: only options (never a positional) follow a resume's.
        "--mcp-config".to_string(),
        r.mcp_config_file.to_string_lossy().into_owned(),
    ];
    // Variadic: only options (never a positional) follow a resume's.
    if let Some(dir) = r.add_dir {
        args.push("--add-dir".into());
        args.push(dir.to_string_lossy().into_owned());
    }
    if let Some(mode) = r.permission_mode.and_then(PermissionMode::as_cli) {
        args.push("--permission-mode".into());
        args.push(mode.into());
    }
    if let Some(file) = r.context_file {
        args.push("--append-system-prompt-file".into());
        args.push(file.to_string_lossy().into_owned());
    }
    args
}

/// Hook events we subscribe to. `MessageDisplay` is left out on purpose (E6).
const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
];
const TOOL_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
];

fn http_hook(port: u16, timeout: u64, status: Option<&str>) -> Value {
    let mut hook = json!({
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/hooks"),
        "headers": {
            "X-App-Token": "$TAIDO_HOOK_TOKEN",
            "X-Terminal-Id": "$TAIDO_TERMINAL_ID"
        },
        "allowedEnvVars": ["TAIDO_HOOK_TOKEN", "TAIDO_TERMINAL_ID"],
        "timeout": timeout
    });
    if let Some(s) = status {
        hook["statusMessage"] = json!(s);
    }
    hook
}

/// Content of `claude-hooks.json`. `SessionStart` accepts only `command` hooks:
/// it relays its stdin to the server with curl, failures ignored (E1). Also pre-allows the
/// app's MCP tools (`permissions.allow`).
pub fn hooks_settings(lang: Language, port: u16) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in EVENTS {
        let hook = match *event {
            "SessionStart" => json!({
                "type": "command",
                "command": format!(
                    "curl -sS -m 3 -o /dev/null -X POST -H 'Content-Type: application/json' \
                     -H \"X-App-Token: $TAIDO_HOOK_TOKEN\" \
                     -H \"X-Terminal-Id: $TAIDO_TERMINAL_ID\" \
                     --data-binary @- http://127.0.0.1:{port}/hooks || true"
                ),
                "timeout": 5
            }),
            "PermissionRequest" => {
                http_hook(port, 600, Some(&i18n::permission_status(lang, APP_NAME)))
            }
            _ => http_hook(port, 5, None),
        };
        let mut group = json!({ "hooks": [hook] });
        if TOOL_EVENTS.contains(event) {
            group["matcher"] = json!("*");
        }
        hooks.insert((*event).to_string(), json!([group]));
    }
    // The app's MCP tools only add to Todo: they run without a permission question
    // (2026-10-05).
    let allow: Vec<String> = crate::mcp::tools::TOOL_NAMES
        .iter()
        .map(|tool| format!("mcp__{}__{tool}", crate::mcp::SERVER_NAME))
        .collect();
    json!({ "hooks": hooks, "permissions": { "allow": allow } })
}

/// Content of `claude-mcp.json` (`--mcp-config`): the app's MCP server on the hook server's
/// port. Claude Code expands `${VAR}` in `headers` from the terminal's environment (spike of
/// 2026-10-05): token and terminal id stay out of the file, as in the hooks.
pub fn mcp_config(port: u16) -> Value {
    let mut servers = serde_json::Map::new();
    servers.insert(
        crate::mcp::SERVER_NAME.to_string(),
        json!({
            "type": "http",
            "url": format!("http://127.0.0.1:{port}/mcp"),
            "headers": {
                "X-App-Token": "${TAIDO_HOOK_TOKEN}",
                "X-Terminal-Id": "${TAIDO_TERMINAL_ID}"
            }
        }),
    );
    json!({ "mcpServers": servers })
}

/// Writes a file readable by the user only (0600), replacing it.
pub fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    std::io::Write::write_all(&mut file, content.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "claude_tests.rs"]
mod tests;
