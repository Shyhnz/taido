//! Login-shell environment resolution.
//!
//! A GUI app launched from the Finder does not inherit the user's shell `PATH`, so `claude`,
//! `node` or `git` may be missing. We run the login shell once, print its environment after a
//! marker, and use that as the base environment for every terminal.
//!
//! Windows has no login shell: an app started from Explorer already gets the user's whole
//! environment, which is used as is.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "__TAIDO_ENV_START__";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Variables injected by a running Claude Code session. When the app itself is started from a
/// Claude Code session (development), they must not leak into terminals, otherwise the `claude`
/// we launch believes it is nested. Kept explicit on purpose: user-set `CLAUDE_CODE_*` variables
/// (e.g. `CLAUDE_CODE_USE_BEDROCK`) must pass through.
pub const CLAUDE_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

/// Fallback `PATH` entries when the login shell cannot be probed.
#[cfg(not(windows))]
const FALLBACK_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.local/bin",
    "~/.npm-global/bin",
];
/// Where Claude Code's native installer puts `claude.exe`, in case `PATH` lacks it.
#[cfg(windows)]
const FALLBACK_PATHS: &[&str] = &["~\\.local\\bin"];

#[derive(Debug, Clone)]
pub struct ResolvedEnv {
    pub vars: BTreeMap<String, String>,
    /// True when the login shell probe succeeded; false when we fell back to the process env.
    pub from_login_shell: bool,
}

impl ResolvedEnv {
    pub fn path(&self) -> &str {
        self.vars.get("PATH").map(String::as_str).unwrap_or("")
    }
}

/// User's login shell (`$SHELL`), defaulting to zsh on macOS.
#[cfg(not(windows))]
pub fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

/// Windows PowerShell, present on every Windows 10 and 11.
#[cfg(windows)]
pub fn login_shell() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
}

/// Arguments of a « Terminal » (interactive shell).
pub fn shell_args() -> Vec<String> {
    if cfg!(windows) {
        vec!["-NoLogo".to_string()]
    } else {
        vec!["-l".to_string()]
    }
}

/// Arguments of a « Commande » terminal: the shell runs `command` and exits.
pub fn command_args(command: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["-NoLogo".into(), "-Command".into(), command.into()]
    } else {
        vec!["-lc".into(), command.into()]
    }
}

/// The user's home folder in `vars`: `HOME`, else `USERPROFILE` (Windows).
pub fn home_dir(vars: &BTreeMap<String, String>) -> Option<&str> {
    vars.get("HOME")
        .or_else(|| vars.get("USERPROFILE"))
        .map(String::as_str)
}

/// Keeps a console program started by the app (git, `claude -v`…) from flashing a console
/// window on Windows. Does nothing elsewhere.
pub fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Resolves the environment of the user's login shell, cleaned of Claude Code session variables.
pub fn resolve() -> ResolvedEnv {
    let probed = if cfg!(windows) {
        None
    } else {
        probe_login_shell()
    };
    let (mut vars, from_login_shell) = match probed {
        Some(vars) => (vars, true),
        None => {
            if !cfg!(windows) {
                tracing::warn!("login shell probe failed, falling back to the process environment");
            }
            (fallback_env(), false)
        }
    };
    for key in CLAUDE_SESSION_VARS {
        vars.remove(*key);
    }
    ResolvedEnv {
        vars,
        from_login_shell,
    }
}

/// Runs `$SHELL -ilc` and parses the environment printed after the marker.
/// Interactive (`-i`) so that PATH changes made in `.zshrc` (nvm, rustup…) are included.
fn probe_login_shell() -> Option<BTreeMap<String, String>> {
    let script = format!("printf '%s' '{MARKER}'; env -0");
    let mut child = Command::new(login_shell())
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = reader.join().ok()?;
    parse_env_output(&output)
}

fn parse_env_output(output: &[u8]) -> Option<BTreeMap<String, String>> {
    let text = String::from_utf8_lossy(output);
    let start = text.rfind(MARKER)? + MARKER.len();
    let vars: BTreeMap<String, String> = text[start..]
        .split('\0')
        .filter_map(|entry| entry.split_once('='))
        .filter(|(key, _)| !key.is_empty())
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    vars.contains_key("PATH").then_some(vars)
}

fn fallback_env() -> BTreeMap<String, String> {
    let mut vars: BTreeMap<String, String> = std::env::vars().collect();
    // Windows names it `Path`; the rest of the core reads `PATH`.
    if let Some(key) = vars
        .keys()
        .find(|k| k.eq_ignore_ascii_case("PATH") && k.as_str() != "PATH")
        .cloned()
    {
        if let Some(value) = vars.remove(&key) {
            vars.insert("PATH".to_string(), value);
        }
    }
    let home = home_dir(&vars).unwrap_or_default().to_string();
    let mut path: Vec<std::path::PathBuf> = vars
        .get("PATH")
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    for extra in FALLBACK_PATHS {
        let extra = std::path::PathBuf::from(extra.replacen('~', &home, 1));
        if !path.contains(&extra) {
            path.push(extra);
        }
    }
    if let Ok(joined) = std::env::join_paths(path) {
        vars.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    }
    vars
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_output_after_marker_ignoring_shell_noise() {
        let out = format!("motd noise\n{MARKER}PATH=/bin:/usr/bin\0HOME=/Users/u\0EMPTY=\0");
        let vars = parse_env_output(out.as_bytes()).expect("parsed");
        assert_eq!(vars.get("PATH").map(String::as_str), Some("/bin:/usr/bin"));
        assert_eq!(vars.get("EMPTY").map(String::as_str), Some(""));
        assert!(!vars.contains_key("motd noise\n"));
    }

    #[test]
    fn keeps_values_containing_equals_and_newlines() {
        let out = format!("{MARKER}PATH=/bin\0FOO=a=b\nc\0");
        let vars = parse_env_output(out.as_bytes()).expect("parsed");
        assert_eq!(vars.get("FOO").map(String::as_str), Some("a=b\nc"));
    }

    #[test]
    fn rejects_output_without_marker_or_path() {
        assert!(parse_env_output(b"PATH=/bin\0").is_none());
        assert!(parse_env_output(format!("{MARKER}HOME=/x\0").as_bytes()).is_none());
    }

    #[test]
    fn resolve_strips_claude_session_vars() {
        let env = resolve();
        for key in CLAUDE_SESSION_VARS {
            assert!(!env.vars.contains_key(*key), "{key} should be removed");
        }
        assert!(!env.path().is_empty());
    }
}
