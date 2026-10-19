//! Claude Code check: `claude -v` and `claude auth status`, run with argument
//! arrays, stdin closed and a timeout. Of `auth status` only the boolean `loggedIn` is kept:
//! its output (email, organisation…) is never stored nor logged.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::model::AgentStatus;

/// Time allowed to each of the two commands.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs the two commands with `bin` (`None`: not found) in the terminals' environment.
pub fn check(
    bin: Option<PathBuf>,
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> AgentStatus {
    let Some(bin) = bin else {
        return AgentStatus {
            path: None,
            version: None,
            logged_in: None,
        };
    };
    let version = run(&bin, &["-v"], env, timeout).and_then(|out| parse_version(&out));
    let logged_in =
        run(&bin, &["auth", "status"], env, timeout).and_then(|out| parse_logged_in(&out));
    AgentStatus {
        path: Some(bin.to_string_lossy().into_owned()),
        version,
        logged_in,
    }
}

/// Standard output of `program args…` (exit status ignored: `auth status` may fail when
/// logged out and still print its JSON). `None` when it cannot start or does not finish in
/// time; the process is then killed.
pub fn run(
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Option<String> {
    let home = crate::env::home_dir(env)
        .map(Path::new)
        .filter(|h| h.is_dir());
    run_in(program, args, env, home, None, timeout)
}

/// Whether `program args…` exits with success (`codex login status`). `None` when it cannot
/// start or does not finish in time; the process is then killed. Output discarded.
pub fn run_status(
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Option<bool> {
    let mut command = Command::new(program);
    crate::env::hide_console(&mut command)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(home) = crate::env::home_dir(env)
        .map(Path::new)
        .filter(|h| h.is_dir())
    {
        command.current_dir(home);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            log::warn!("cannot run {} {}: {e}", program.display(), args.join(" "));
            return None;
        }
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!(
                    "{} {} did not answer within {timeout:?}",
                    program.display(),
                    args.join(" ")
                );
                return None;
            }
        }
    }
}

/// Like [`run`], in `cwd` (else the current folder), with `input` written to stdin.
pub fn run_in(
    program: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    cwd: Option<&Path>,
    input: Option<&str>,
    timeout: Duration,
) -> Option<String> {
    let mut command = Command::new(program);
    crate::env::hide_console(&mut command)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            log::warn!("cannot run {} {}: {e}", program.display(), args.join(" "));
            return None;
        }
    };
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        let text = text.to_string();
        // Detached: a full pipe must not block us past the deadline.
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let deadline = Instant::now() + timeout;
    let (tx, rx) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        // Detached: a grandchild keeping the pipe open must not block us past the deadline.
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let output = rx.recv_timeout(timeout).ok();
    // The output is complete (end of file); give the process what is left to exit.
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                if output.is_none() {
                    log::warn!(
                        "{} {} did not answer within {timeout:?}",
                        program.display(),
                        args.join(" ")
                    );
                }
                break;
            }
        }
    }
    output.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// First token shaped like a version (`2.1.288`, `2.1.288-beta.1`) in `claude -v`'s output
/// (`2.1.288 (Claude Code)`).
pub fn parse_version(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .map(|t| t.strip_prefix('v').unwrap_or(t))
        .find(|t| {
            let core = t.split(['-', '+']).next().unwrap_or("");
            let parts: Vec<&str> = core.split('.').collect();
            parts.len() >= 2
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        })
        .map(str::to_string)
}

/// Only field read from `claude auth status`; everything else is dropped by serde.
#[derive(Deserialize)]
struct AuthStatus {
    #[serde(rename = "loggedIn")]
    logged_in: Option<bool>,
}

/// `loggedIn` of the JSON printed by `claude auth status` (tolerates text around it).
pub fn parse_logged_in(output: &str) -> Option<bool> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    if end < start {
        return None;
    }
    serde_json::from_str::<AuthStatus>(&output[start..=end])
        .ok()?
        .logged_in
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_real_outputs() {
        let cases = [
            ("2.1.288 (Claude Code)\n", Some("2.1.288")),
            ("1.0.17 (Claude Code)", Some("1.0.17")),
            ("Claude Code v2.0.1-beta.3\n", Some("2.0.1-beta.3")),
            ("warning: something\n2.1.288 (Claude Code)", Some("2.1.288")),
            ("", None),
            ("Claude Code", None),
            ("error 2 occurred", None),
            ("1. step", None),
        ];
        for (output, expected) in cases {
            assert_eq!(parse_version(output).as_deref(), expected, "{output:?}");
        }
    }

    #[test]
    fn only_logged_in_is_read_from_auth_status() {
        // Shape captured from `claude auth status` 2.1.288 (values replaced).
        let logged = r#"{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/Users/u/.claude/projects",
  "configDirectory": "/Users/u/.claude",
  "email": "someone@example.com",
  "orgId": "00000000-0000-0000-0000-000000000000",
  "orgName": "Org",
  "subscriptionType": "max"
}"#;
        let cases = [
            (logged.to_string(), Some(true)),
            (
                r#"{"loggedIn": false, "authMethod": "none"}"#.to_string(),
                Some(false),
            ),
            (format!("Checking…\n{logged}\n"), Some(true)),
            (r#"{"authMethod": "none"}"#.to_string(), None),
            (r#"{"loggedIn": "yes"}"#.to_string(), None),
            ("Not logged in".to_string(), None),
            ("} {".to_string(), None),
            (String::new(), None),
        ];
        for (output, expected) in cases {
            assert_eq!(parse_logged_in(&output), expected, "{output:?}");
        }
    }

    /// Writes an executable shell script `claude` in `dir`.
    fn script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("claude");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        path
    }

    fn env_with(dir: &Path) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), "/usr/bin:/bin".into());
        env.insert("HOME".into(), dir.to_string_lossy().into_owned());
        env.insert("FAKE_LOGGED".into(), "true".into());
        env
    }

    #[test]
    fn check_runs_both_commands_with_the_given_environment() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Reads stdin to prove it is closed (would block otherwise), and an env variable.
        let bin = script(
            dir.path(),
            r#"cat > /dev/null
case "$1" in
  -v) echo "2.1.288 (Claude Code)" ;;
  auth) [ "$2" = status ] && printf '{"loggedIn": %s, "email": "a@b.c"}\n' "$FAKE_LOGGED"; exit 1 ;;
esac"#,
        );
        let status = check(Some(bin.clone()), &env_with(dir.path()), CHECK_TIMEOUT);
        assert_eq!(
            status,
            AgentStatus {
                path: Some(bin.to_string_lossy().into_owned()),
                version: Some("2.1.288".into()),
                logged_in: Some(true),
            }
        );
    }

    #[test]
    fn missing_binary_and_unreadable_answers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let none = check(None, &env_with(dir.path()), CHECK_TIMEOUT);
        assert_eq!(none.path, None);
        assert_eq!((none.version, none.logged_in), (None, None));

        let bin = script(dir.path(), "echo 'unknown option' >&2; exit 2");
        let status = check(Some(bin.clone()), &env_with(dir.path()), CHECK_TIMEOUT);
        assert_eq!(status.path, Some(bin.to_string_lossy().into_owned()));
        assert_eq!((status.version, status.logged_in), (None, None));
    }

    #[test]
    fn a_hanging_command_is_killed_at_the_timeout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = script(dir.path(), "exec sleep 30");
        let start = Instant::now();
        let status = check(Some(bin), &env_with(dir.path()), Duration::from_millis(300));
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "{:?}",
            start.elapsed()
        );
        assert_eq!((status.version, status.logged_in), (None, None));
    }
}
