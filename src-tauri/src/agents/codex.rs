//! Codex launch: binary detection and
//! command-line arguments. Codex is configured only with `-c key=value` overrides (TOML
//! values), never through `~/.codex` nor the task's folder. Pure functions.

use std::path::Path;

use super::{BinarySpec, Os};

/// Development override pointing to `fake-codex` (like `TAIDO_CLAUDE_BIN`).
pub const CODEX_BIN_VAR: &str = "TAIDO_CODEX_BIN";
/// URL of the hook server, read by the relay: the port changes at every app launch, the
/// hooks' text must not (Codex asks the user to trust a hook again when its text changes).
pub const HOOK_URL_VAR: &str = "TAIDO_HOOK_URL";

pub const BINARY: BinarySpec = BinarySpec {
    name: "codex",
    common_locations: &[
        "~/.local/bin/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
    ],
    // npm's `codex.cmd` (`npm install -g @openai/codex`).
    windows_dirs: &[super::WINDOWS_NPM_DIR],
};

/// Hook events we subscribe to: the same names as Claude's, plus `Interrupt`.
pub const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "Interrupt",
    "SessionEnd",
];

/// Every hook runs this fixed command, the payload on stdin. Codex clamps some hook timeouts
/// to 3 s: curl gives up after 2.
const RELAY: &str = "curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' \
-H \"X-App-Token: $TAIDO_HOOK_TOKEN\" -H \"X-Terminal-Id: $TAIDO_TERMINAL_ID\" \
--data-binary @- \"$TAIDO_HOOK_URL\" || true";

/// The relay on Windows, where Codex runs `command_windows` instead of `command`: the same
/// POST through Windows PowerShell (present on every Windows 10 and 11). The payload is read
/// as UTF-8 and sent as bytes; nothing is printed (Codex reads a hook's output).
const RELAY_WINDOWS: &str = "$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$body = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
try {
  Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 -Uri $env:TAIDO_HOOK_URL `
    -ContentType 'application/json' -Body $body `
    -Headers @{ 'X-App-Token' = $env:TAIDO_HOOK_TOKEN; 'X-Terminal-Id' = $env:TAIDO_TERMINAL_ID } |
    Out-Null
} catch {}
exit 0";

/// `-EncodedCommand` (base64 of UTF-16LE): no character for cmd.exe or PowerShell to read,
/// whichever shell Codex runs the command with.
fn relay_windows() -> String {
    use base64::Engine as _;
    let bytes: Vec<u8> = RELAY_WINDOWS
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// The `-c` override of one hook event. Windows adds `command_windows`; macOS keeps the
/// text it always had (Codex asks to trust a hook again when its text changes).
pub(crate) fn hook_override(event: &str, os: Os) -> String {
    let windows = match os {
        Os::Windows => format!(", command_windows = {}", toml_string(&relay_windows())),
        Os::Unix => String::new(),
    };
    format!(
        "hooks.{event}=[{{ matcher = \"*\", hooks = [{{ type = \"command\", command = {}{windows}, \
         timeout = 3 }}] }}]",
        toml_string(RELAY)
    )
}

/// What a launch (or a resume) needs.
pub struct Launch<'a> {
    /// Port of the hook server, for the MCP server's URL.
    pub port: u16,
    /// Task context (`agents::context_text`), added to Codex's instructions.
    pub context: Option<&'a str>,
    /// First message; ignored by a resume.
    pub prompt: Option<&'a str>,
    /// The task's attachments folder.
    pub add_dir: Option<&'a Path>,
}

/// A TOML basic string (JSON escapes are valid TOML ones for these characters).
pub(crate) fn toml_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The options shared by a new session and a resume.
fn options(l: &Launch<'_>) -> Vec<String> {
    let server = crate::mcp::SERVER_NAME;
    let mut overrides = vec![
        format!(
            "mcp_servers.{server}.url={}",
            toml_string(&format!("http://127.0.0.1:{}/mcp", l.port))
        ),
        format!(
            "mcp_servers.{server}.env_http_headers={{ \"X-App-Token\" = \"TAIDO_HOOK_TOKEN\", \
             \"X-Terminal-Id\" = \"TAIDO_TERMINAL_ID\" }}"
        ),
        // The app's tools only add to Taido: no question (like Claude's `permissions.allow`).
        format!("mcp_servers.{server}.default_tools_approval_mode=\"approve\""),
    ];
    if let Some(context) = l.context {
        overrides.push(format!("developer_instructions={}", toml_string(context)));
    }
    for event in EVENTS {
        overrides.push(hook_override(event, Os::CURRENT));
    }
    // `-c` makes Codex run without its shared background server: say so, or it warns.
    let mut args = vec!["--no-daemon".to_string()];
    for o in overrides {
        args.push("-c".into());
        args.push(o);
    }
    if let Some(dir) = l.add_dir {
        args.push("--add-dir".into());
        args.push(dir.to_string_lossy().into_owned());
    }
    args
}

/// Arguments of a new Codex session, as an array: no shell involved.
pub fn new_session_args(l: &Launch<'_>) -> Vec<String> {
    let mut args = options(l);
    if let Some(prompt) = l.prompt.map(str::trim).filter(|p| !p.is_empty()) {
        // A prompt starting with "-" would be read as an option.
        if prompt.starts_with('-') {
            args.push(format!(" {prompt}"));
        } else {
            args.push(prompt.to_string());
        }
    }
    args
}

/// `codex resume <id>` with the same options (Codex does not keep the `-c` of a session).
pub fn resume_args(conversation_id: &str, l: &Launch<'_>) -> Vec<String> {
    let mut args = vec!["resume".to_string(), conversation_id.to_string()];
    args.extend(options(l));
    args
}

/// Variables a Codex terminal gets besides the common ones (token, terminal id).
pub fn launch_env(port: u16) -> Vec<(String, String)> {
    vec![(
        HOOK_URL_VAR.to_string(),
        format!("http://127.0.0.1:{port}/hooks"),
    )]
}

#[cfg(test)]
#[path = "codex_tests.rs"]
mod tests;
