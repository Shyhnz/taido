//! Login-shell environment resolution.
//!
//! A GUI app launched from the Finder does not inherit the user's shell `PATH`, so `claude`,
//! `node` or `git` may be missing. We run the login shell once, print its environment after a
//! marker, and use that as the base environment for every terminal.
//!
//! Windows has no login shell: an app started from Explorer already gets the user's whole
//! environment, which is used as is.

use std::collections::BTreeMap;
#[cfg(not(windows))]
use std::io::Read;
use std::process::{Command, Stdio};
#[cfg(not(windows))]
use std::time::{Duration, Instant};

// Windows has no login shell to probe: the marker and its parser are only used elsewhere
// (and by the tests).
#[cfg_attr(windows, allow(dead_code))]
const MARKER: &str = "__TAIDO_ENV_START__";
#[cfg(not(windows))]
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

/// The program of a « Terminal » or « Commande » terminal: the login shell.
#[cfg(not(windows))]
pub fn terminal_shell(_vars: &BTreeMap<String, String>) -> String {
    login_shell()
}

/// The program of a « Terminal » or « Commande » terminal: PowerShell ([`windows_shell`]),
/// looked for in the terminals' environment `vars`.
#[cfg(windows)]
pub fn terminal_shell(vars: &BTreeMap<String, String>) -> String {
    let get = |name: &str| {
        vars.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    };
    windows_shell(get("PATH").unwrap_or(""), get("SystemRoot"), |p| {
        std::path::Path::new(p).is_file()
    })
}

/// Windows shell: PowerShell 7 (`pwsh.exe`) when a folder of `path` (`;`-separated) has it,
/// else Windows PowerShell, present on every Windows 10 and 11. Pure: `exists` says whether a
/// file is there.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_shell(
    path: &str,
    system_root: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> String {
    let pwsh = path
        .split(';')
        .map(|dir| dir.trim().trim_matches('"').trim_end_matches(['\\', '/']))
        .filter(|dir| !dir.is_empty())
        .map(|dir| format!("{dir}\\pwsh.exe"))
        .find(|candidate| exists(candidate));
    pwsh.unwrap_or_else(|| {
        let root = system_root
            .map(|r| r.trim_end_matches(['\\', '/']))
            .filter(|r| !r.is_empty())
            .unwrap_or("C:\\Windows");
        format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    })
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

/// Windows has no process groups to signal: `taskkill /T /F` ends a process and every process
/// it started (its tree), at once.
#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    let pid = pid.to_string();
    let status = hide_console(&mut Command::new("taskkill"))
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if let Err(e) = status {
        log::warn!("cannot run taskkill for {pid}: {e}");
    }
}

/// Arguments for `program`, made safe when it is a batch file (`.cmd`, `.bat`) that is not an
/// npm or pnpm shim Taido can skip (`agents::launch_command`). Windows runs a batch file
/// through `cmd.exe /c` without `/s`: with more than two quotes on the line, cmd drops the
/// first and the last one, which shifts every quoted argument, so no quoting can be trusted;
/// and `%*` expands inside the batch body before it is parsed, where a `)` closes an
/// `IF … ( … )` block. Every argument is therefore made free of what cmd.exe interprets: `"`
/// becomes `'`, line breaks become spaces, blanks become no-break spaces (a blank would make
/// the command line quote the argument, and a path with blanks quotes the program: three
/// quotes or more and cmd drops the first one, which cuts the program's path), and `& | < > ^ % ! ( )` become their full-width
/// look-alikes (`＆ ｜ ＜ ＞ ＾ ％ ！ （ ）`). Paths passed as arguments that contain these
/// characters (an attachments folder `Task (abc123)`) then point nowhere: a limit of such
/// unrecognised launchers only. The outer-quote form `cmd /d /s /c "…"` (Rust's std) cannot
/// be built here: portable-pty 0.9 writes every inner `"` as `\"`, which cmd.exe does not
/// understand. Any other program gets its arguments untouched.
pub fn batch_safe_args(program: &str, args: &[String]) -> Vec<String> {
    let lower = program.to_ascii_lowercase();
    if !(lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        return args.to_vec();
    }
    args.iter()
        .map(|arg| {
            if arg.is_empty() {
                // An empty argument would be written as `""`.
                return "\u{A0}".to_string();
            }
            arg.chars()
                .map(|c| match c {
                    '"' => '\'',
                    ' ' | '\t' | '\r' | '\n' => '\u{A0}',
                    '&' => '\u{FF06}',
                    '|' => '\u{FF5C}',
                    '<' => '\u{FF1C}',
                    '>' => '\u{FF1E}',
                    '^' => '\u{FF3E}',
                    '%' => '\u{FF05}',
                    '!' => '\u{FF01}',
                    '(' => '\u{FF08}',
                    ')' => '\u{FF09}',
                    c => c,
                })
                .collect()
        })
        .collect()
}

/// Resolves the environment of the user's login shell, cleaned of Claude Code session variables.
pub fn resolve() -> ResolvedEnv {
    #[cfg(windows)]
    let probed = None;
    #[cfg(not(windows))]
    let probed = probe_login_shell();
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
#[cfg(not(windows))]
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

#[cfg_attr(windows, allow(dead_code))]
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
    fn default_shell_on_windows_prefers_pwsh() {
        let path = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7\\;C:\\Tools";
        let with_pwsh = windows_shell(path, Some("C:\\Windows"), |p| {
            p == "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
        });
        assert_eq!(with_pwsh, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
        assert!(with_pwsh.ends_with("pwsh.exe"));

        let without = windows_shell(path, Some("D:\\WINDOWS"), |_| false);
        assert_eq!(
            without,
            "D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
        assert_eq!(
            windows_shell("", None, |_| true),
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
    }

    #[test]
    fn batch_shim_arguments_cannot_break_out() {
        let args: Vec<String> = [
            "--name",
            "Acme · \"Q&A\" 100%",
            "a&b|c>d<e^f",
            "two\nlines",
            "C:\\Users\\Jane Doe\\AppData\\Roaming\\taido\\claude-hooks.json",
        ]
        .map(String::from)
        .to_vec();
        let safe = batch_safe_args(
            "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.CMD",
            &args,
        );
        assert_eq!(
            safe,
            [
                "--name",
                "Acme\u{A0}·\u{A0}'Q\u{FF06}A'\u{A0}100\u{FF05}",
                "a\u{FF06}b\u{FF5C}c\u{FF1E}d\u{FF1C}e\u{FF3E}f",
                "two\u{A0}lines",
                "C:\\Users\\Jane\u{A0}Doe\\AppData\\Roaming\\taido\\claude-hooks.json",
            ]
        );
        // A real program gets its arguments untouched.
        assert_eq!(batch_safe_args("C:\\Tools\\claude.exe", &args), args);
        assert_eq!(batch_safe_args("/usr/local/bin/claude", &args), args);
        assert_eq!(batch_safe_args("C:\\x\\run.bat", &args), safe);
    }

    /// The command line portable-pty 0.9 gives `CreateProcessW` for a batch file (blank-free
    /// arguments as they are, the others in quotes), then what cmd.exe runs: without `/s` and
    /// with more than two quotes it drops the first and the last quote of the line.
    fn as_cmd_runs_it(program: &str, args: &[String]) -> String {
        let quote = |a: &str| {
            if a.is_empty() || a.contains([' ', '\t', '"']) {
                format!("\"{a}\"")
            } else {
                a.to_string()
            }
        };
        let line: Vec<String> = std::iter::once(program)
            .chain(args.iter().map(String::as_str))
            .map(quote)
            .collect();
        let line = line.join(" ");
        let first = line.find('"').map_or(line.clone(), |i| {
            let mut l = line.clone();
            l.remove(i);
            l
        });
        match first.rfind('"') {
            Some(i) => {
                let mut l = first.clone();
                l.remove(i);
                l
            }
            None => first,
        }
    }

    #[test]
    fn user_text_never_reaches_cmd_as_an_operator() {
        let program = "C:\\Users\\Jane Doe\\tools\\run.cmd";
        let args: Vec<String> = [
            "--name",
            "a & echo pwned> p.txt",
            "b\" & echo pwned2> p2.txt",
            "solo|x",
            "%PATH%!x!^",
            "x)else(calc",
            "C:\\Users\\Jane Doe\\Taido\\Attachments\\Globex\\Task (abc123)",
        ]
        .map(String::from)
        .to_vec();
        let safe = batch_safe_args(program, &args);
        // Whatever cmd.exe does with the quotes, no operator nor expansion is left.
        let line = as_cmd_runs_it(program, &safe);
        let after_program = &line[line.find("run.cmd").expect("program") + 7..];
        for c in ['&', '|', '<', '>', '^', '%', '!', '(', ')'] {
            assert!(!after_program.contains(c), "{c:?} in {line}");
        }
        assert_eq!(
            safe[1],
            "a\u{A0}\u{FF06}\u{A0}echo\u{A0}pwned\u{FF1E}\u{A0}p.txt"
        );
        assert_eq!(
            safe[2],
            "b'\u{A0}\u{FF06}\u{A0}echo\u{A0}pwned2\u{FF1E}\u{A0}p2.txt"
        );
        // `%*` inside an `IF … ( … )` block: a `)` would close it.
        assert_eq!(safe[5], "x\u{FF09}else\u{FF08}calc");
        assert_eq!(
            safe[6],
            "C:\\Users\\Jane\u{A0}Doe\\Taido\\Attachments\\Globex\\Task\u{A0}\u{FF08}abc123\u{FF09}"
        );
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
