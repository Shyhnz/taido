//! Codex launch: binary detection and
//! command-line arguments. Codex is configured only with `-c key=value` overrides (TOML
//! values), never through `~/.codex` nor the task's folder. Pure functions.

use super::BinarySpec;

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

/// The relay on Windows, where Codex runs `command_windows` instead of `command`, through the
/// user's shell: PowerShell (`pwsh`, else Windows PowerShell) with `-NoProfile -Command`, or
/// `cmd.exe /C` when there is none (codex-rs `hooks/src/engine/command_runner.rs`,
/// `build_command`). So the command must mean the same to both shells.
// Built only on Windows (and in the tests).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WindowsRelay {
    /// Windows' own `curl.exe` at this path (curl 8.3 or later, in Windows since the November
    /// 2023 updates): starts in a few milliseconds.
    Curl(String),
    /// Older Windows: the same POST through Windows PowerShell, much slower to start.
    PowerShell,
}

/// The curl relay on Windows. Nothing in it is read by cmd.exe or PowerShell: curl itself
/// imports the variables (`--variable %NAME`, which cmd leaves alone since no `%NAME%` pair is
/// closed) and expands them (`{{NAME}}`, quoted so PowerShell does not see a script block).
/// `@-` is quoted too (PowerShell splatting). The payload goes from stdin to the server as is.
const RELAY_WINDOWS_CURL: &str = "{curl} -s -m 2 -o NUL --variable %TAIDO_HOOK_URL \
--variable %TAIDO_HOOK_TOKEN --variable %TAIDO_TERMINAL_ID -H \"Content-Type: application/json\" \
--expand-header \"X-App-Token: {{TAIDO_HOOK_TOKEN}}\" \
--expand-header \"X-Terminal-Id: {{TAIDO_TERMINAL_ID}}\" \
--data-binary \"@-\" --expand-url \"{{TAIDO_HOOK_URL}}\"";

/// The PowerShell relay, for a Windows without a recent curl. The payload is read as UTF-8
/// and sent as bytes; nothing is printed (Codex reads a hook's output).
const RELAY_WINDOWS_POWERSHELL: &str = "$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$body = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
try {
  Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 2 -Uri $env:TAIDO_HOOK_URL `
    -ContentType 'application/json' -Body $body `
    -Headers @{ 'X-App-Token' = $env:TAIDO_HOOK_TOKEN; 'X-Terminal-Id' = $env:TAIDO_TERMINAL_ID } |
    Out-Null
} catch {}
exit 0";

/// The `command_windows` text of `relay`.
fn command_windows(relay: &WindowsRelay) -> String {
    match relay {
        WindowsRelay::Curl(curl) => RELAY_WINDOWS_CURL.replace("{curl}", curl),
        // `-EncodedCommand` (base64 of UTF-16LE): no character for cmd.exe or PowerShell to
        // read.
        WindowsRelay::PowerShell => {
            use base64::Engine as _;
            let bytes: Vec<u8> = RELAY_WINDOWS_POWERSHELL
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            format!(
                "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        }
    }
}

/// Whether the first line of `curl --version` names curl 8.3 or later (`--variable`).
#[cfg(any(windows, test))]
pub(crate) fn curl_has_variables(version_output: &str) -> bool {
    let mut numbers = version_output
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .split('.')
        .map(|n| n.parse::<u32>().ok());
    let (Some(Some(major)), Some(Some(minor))) = (numbers.next(), numbers.next()) else {
        return false;
    };
    (major, minor) >= (8, 3)
}

/// A curl path is written unquoted (a quoted path at the start of a command is a mere string
/// to PowerShell): only characters neither shell reads.
#[cfg(any(windows, test))]
pub(crate) fn plain_path(path: &str) -> bool {
    !path.is_empty()
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "\\:._-".contains(c))
}

/// This Windows' relay, looked up once: `%SystemRoot%\System32\curl.exe` when it is recent
/// enough, else PowerShell.
#[cfg(windows)]
fn windows_relay() -> &'static WindowsRelay {
    static RELAY: std::sync::OnceLock<WindowsRelay> = std::sync::OnceLock::new();
    RELAY.get_or_init(|| {
        let Some(root) = std::env::var_os("SystemRoot") else {
            return WindowsRelay::PowerShell;
        };
        let curl = std::path::Path::new(&root)
            .join("System32")
            .join("curl.exe");
        let curl = curl.to_string_lossy().into_owned();
        if !plain_path(&curl) {
            return WindowsRelay::PowerShell;
        }
        let output = crate::env::hide_console(&mut std::process::Command::new(&curl))
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .output();
        match output {
            Ok(o)
                if o.status.success()
                    && curl_has_variables(&String::from_utf8_lossy(&o.stdout)) =>
            {
                WindowsRelay::Curl(curl)
            }
            _ => {
                log::warn!("no curl 8.3 or later in System32: Codex hooks go through PowerShell");
                WindowsRelay::PowerShell
            }
        }
    })
}

/// Codex caps the timeout of `SessionEnd` and `Interrupt` hooks at 3 s and lets the others
/// run longer (codex-rs `hooks/src/engine/discovery.rs`, `normalize_command_hook`).
const CAPPED_EVENTS: &[&str] = &["SessionEnd", "Interrupt"];
/// Timeout of the other hooks on Windows, where PowerShell alone can take seconds to start on
/// a busy computer: a late hook still arrives instead of being killed.
const WINDOWS_TIMEOUT: u32 = 10;

/// The `-c` override of one hook event. Windows (`windows` given) adds `command_windows` and
/// a longer timeout where Codex allows one; macOS keeps the text it always had (Codex asks to
/// trust a hook again when its text changes).
pub(crate) fn hook_override(event: &str, windows: Option<&WindowsRelay>) -> String {
    let (windows, timeout) = match windows {
        Some(relay) => (
            format!(
                ", command_windows = {}",
                toml_string(&command_windows(relay))
            ),
            if CAPPED_EVENTS.contains(&event) {
                3
            } else {
                WINDOWS_TIMEOUT
            },
        ),
        None => (String::new(), 3),
    };
    format!(
        "hooks.{event}=[{{ matcher = \"*\", hooks = [{{ type = \"command\", command = {}{windows}, \
         timeout = {timeout} }}] }}]",
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
    #[cfg(windows)]
    let windows = Some(windows_relay());
    #[cfg(not(windows))]
    let windows = None;
    for event in EVENTS {
        overrides.push(hook_override(event, windows));
    }
    // `-c` makes Codex run without its shared background server: say so, or it warns.
    let mut args = vec!["--no-daemon".to_string()];
    for o in overrides {
        args.push("-c".into());
        args.push(o);
    }
    // No `--add-dir` for the attachments: in a folder Codex does not trust it starts
    // read-only, rejects that option and exits. It reads them anyway, their paths are in
    // the context.
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
