// The Unix-only tests (shell-script fakes) are the only users of some imports.
#![cfg_attr(not(unix), allow(unused_imports))]

use std::collections::BTreeMap;
use std::path::Path;

use super::*;

fn launch() -> Launch<'static> {
    Launch {
        port: 4242,
        context: None,
        prompt: None,
    }
}

/// The values of the `-c` overrides, parsed as TOML like Codex does.
fn overrides(args: &[String]) -> Vec<toml::Table> {
    args.windows(2)
        .filter(|w| w[0] == "-c")
        .map(|w| toml::from_str::<toml::Table>(&w[1]).expect("valid TOML override"))
        .collect()
}

#[test]
fn hooks_are_the_same_text_at_every_launch() {
    let a = new_session_args(&launch());
    let b = new_session_args(&Launch {
        port: 5151,
        ..launch()
    });
    let hooks = |args: &[String]| -> Vec<String> {
        args.iter()
            .filter(|a| a.starts_with("hooks."))
            .cloned()
            .collect()
    };
    assert_eq!(hooks(&a).len(), EVENTS.len());
    assert_eq!(
        hooks(&a),
        hooks(&b),
        "a new port must not ask for a new trust"
    );
    for h in hooks(&a) {
        assert!(h.contains("$TAIDO_HOOK_URL"), "{h}");
        assert!(!h.contains("4242"), "{h}");
        let capped = h.starts_with("hooks.SessionEnd=") || h.starts_with("hooks.Interrupt=");
        let timeout = if cfg!(windows) && !capped { 10 } else { 3 };
        assert!(
            h.contains(&format!("timeout = {timeout} ")),
            "Codex caps SessionEnd and Interrupt at 3 s: {h}"
        );
    }
}

/// The handler table of one event's override.
fn handler(event: &str, windows: Option<&WindowsRelay>) -> toml::Table {
    let table = toml::from_str::<toml::Table>(&hook_override(event, windows)).expect("toml");
    table["hooks"][event][0]["hooks"][0]
        .as_table()
        .expect("handler")
        .clone()
}

const SYSTEM_CURL: &str = r"C:\Windows\System32\curl.exe";

#[test]
fn macos_hooks_keep_their_exact_text() {
    // A changed hook text makes Codex ask the user to trust it again.
    assert_eq!(
        hook_override("Stop", None),
        r#"hooks.Stop=[{ matcher = "*", hooks = [{ type = "command", command = "curl -s -m 2 -o /dev/null -X POST -H 'Content-Type: application/json' -H \"X-App-Token: $TAIDO_HOOK_TOKEN\" -H \"X-Terminal-Id: $TAIDO_TERMINAL_ID\" --data-binary @- \"$TAIDO_HOOK_URL\" || true", timeout = 3 }] }]"#
    );
    assert!(!handler("SessionEnd", None).contains_key("command_windows"));
}

#[test]
fn windows_hooks_go_through_the_system_curl() {
    let relay = WindowsRelay::Curl(SYSTEM_CURL.into());
    let win = handler("Stop", Some(&relay));
    assert_eq!(win["command"], handler("Stop", None)["command"]);
    let command = win["command_windows"].as_str().expect("command_windows");
    assert_eq!(
        command,
        r#"C:\Windows\System32\curl.exe -s -m 2 -o NUL --variable %TAIDO_HOOK_URL --variable %TAIDO_HOOK_TOKEN --variable %TAIDO_TERMINAL_ID -H "Content-Type: application/json" --expand-header "X-App-Token: {{TAIDO_HOOK_TOKEN}}" --expand-header "X-Terminal-Id: {{TAIDO_TERMINAL_ID}}" --data-binary "@-" --expand-url "{{TAIDO_HOOK_URL}}""#
    );
    // Nothing PowerShell or cmd.exe would read: no variable of theirs, no operator.
    for c in ['$', '`', '&', '|', ';', '<', '>', '^', '\'', '(', ')'] {
        assert!(!command.contains(c), "{c} in {command}");
    }
    // Each `%` opens curl's `--variable %NAME`; no `%NAME%` pair for cmd.exe to expand.
    for (i, _) in command.match_indices('%') {
        let name: String = command[i + 1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        assert!(name.starts_with("TAIDO_"), "{command}");
        assert_eq!(command[i + 1 + name.len()..].chars().next(), Some(' '));
    }
    // Every `{{` sits inside double quotes (PowerShell would read a bare `{` as a script block).
    assert!(command
        .split('"')
        .step_by(2)
        .all(|outside| !outside.contains('{')));
    assert_eq!(win["timeout"].as_integer(), Some(10));
    for capped in ["SessionEnd", "Interrupt"] {
        assert_eq!(
            handler(capped, Some(&relay))["timeout"].as_integer(),
            Some(3)
        );
    }
}

#[test]
fn old_windows_hooks_go_through_powershell() {
    use base64::Engine as _;
    let win = handler("Stop", Some(&WindowsRelay::PowerShell));
    let command = win["command_windows"].as_str().expect("command_windows");
    let encoded = command
        .strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")
        .expect("powershell");
    // Only base64 characters: nothing any shell would interpret.
    assert!(encoded
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("base64");
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let script = String::from_utf16(&units).expect("UTF-16LE");
    for needle in [
        "$env:TAIDO_HOOK_URL",
        "$env:TAIDO_HOOK_TOKEN",
        "$env:TAIDO_TERMINAL_ID",
        "-TimeoutSec 2",
        "Out-Null",
    ] {
        assert!(script.contains(needle), "{needle} in {script}");
    }
}

#[test]
fn only_curl_8_3_or_later_imports_variables() {
    for (line, ok) in [
        (
            "curl 8.21.0 (Windows) libcurl/8.21.0 Schannel zlib/1.3.2 WinIDN",
            true,
        ),
        (
            "curl 8.4.0 (x86_64-pc-win32) libcurl/8.4.0 Schannel WinIDN",
            true,
        ),
        ("curl 8.3.0 (Windows)", true),
        ("curl 10.0.1 (Windows)", true),
        ("curl 8.2.1 (Windows)", false),
        ("curl 7.55.1 (Windows) libcurl/7.55.1 WinSSL", false),
        ("", false),
        ("curl", false),
    ] {
        assert_eq!(curl_has_variables(line), ok, "{line}");
    }
}

#[test]
fn only_a_plain_curl_path_is_written_unquoted() {
    assert!(plain_path(SYSTEM_CURL));
    assert!(plain_path(r"D:\WINDOWS\System32\curl.exe"));
    for path in [
        "",
        r"C:\Program Files\curl.exe",
        r"C:\a&b\curl.exe",
        r"C:\x%y%\curl.exe",
    ] {
        assert!(!plain_path(path), "{path}");
    }
}

/// The relay this Windows uses, run the way Codex runs `command_windows` (codex-rs
/// `build_command`): `cmd.exe /C "<command>"` (raw), `pwsh` and Windows PowerShell with
/// `-NoProfile -Command <command>`. Each must deliver the payload and both headers untouched.
#[cfg(windows)]
#[test]
fn the_windows_relay_posts_through_every_shell_codex_uses() {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt as _;
    use std::process::{Command, Stdio};

    let relay = windows_relay();
    assert!(
        matches!(relay, WindowsRelay::Curl(_)),
        "Windows 10 and 11 have curl 8.3+: {relay:?}"
    );
    let command = command_windows(relay);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.set_nonblocking(true).expect("nonblocking");
    let port = listener.local_addr().expect("addr").port();
    let payload = r#"{"hook_event_name":"Stop","text":"é 日本 \"q\" %PATH% $env:PATH {{x}}"}"#;
    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    let mut shells: Vec<(&str, Command)> = Vec::new();
    let mut cmd = Command::new(&comspec);
    cmd.arg("/C").raw_arg(format!("\"{command}\""));
    shells.push(("cmd", cmd));
    for ps in ["pwsh", "powershell"] {
        let mut c = Command::new(ps);
        c.args(["-NoProfile", "-Command", &command]);
        shells.push((ps, c));
    }
    for (name, mut shell) in shells {
        let terminal = format!("term-{name}");
        let child = shell
            .env("TAIDO_HOOK_URL", format!("http://127.0.0.1:{port}/hooks"))
            .env("TAIDO_HOOK_TOKEN", "tok en%PATH%")
            .env("TAIDO_TERMINAL_ID", &terminal)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let Ok(mut child) = child else {
            assert_ne!(name, "cmd", "cmd.exe must start");
            assert_ne!(name, "powershell", "Windows PowerShell must start");
            continue; // no pwsh on this computer
        };
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(payload.as_bytes())
            .expect("payload");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if let Ok(Some(status)) = child.try_wait() {
                        panic!("{name}: exited ({status}) without posting");
                    }
                    assert!(std::time::Instant::now() < deadline, "{name}: no request");
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(e) => panic!("{name}: accept: {e}"),
            }
        };
        stream.set_nonblocking(false).expect("blocking");
        let mut request = Vec::new();
        let mut buf = [0u8; 4096];
        let body_start = loop {
            let n = stream.read(&mut buf).expect("read");
            assert!(n > 0, "{name}: request cut short");
            request.extend_from_slice(&buf[..n]);
            if let Some(i) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let head = String::from_utf8_lossy(&request[..body_start]).to_string();
        let length: usize = head
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().to_string())
            })
            .and_then(|v| v.parse().ok())
            .expect("content-length");
        while request.len() < body_start + length {
            let n = stream.read(&mut buf).expect("read body");
            assert!(n > 0, "{name}: body cut short");
            request.extend_from_slice(&buf[..n]);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .expect("reply");
        drop(stream);
        let output = child.wait_with_output().expect("wait");
        assert!(output.status.success(), "{name}: {output:?}");
        assert!(
            head.starts_with("POST /hooks HTTP/1.1\r\n"),
            "{name}: {head}"
        );
        for header in [
            "Content-Type: application/json".to_string(),
            "X-App-Token: tok en%PATH%".to_string(),
            format!("X-Terminal-Id: {terminal}"),
        ] {
            assert!(
                head.contains(&format!("{header}\r\n")),
                "{name}: {header} in {head}"
            );
        }
        assert_eq!(&request[body_start..], payload.as_bytes(), "{name}");
        assert!(
            output.stdout.is_empty(),
            "{name}: Codex reads a hook's output"
        );
    }
}

#[test]
fn every_override_is_valid_toml_and_follows_a_dash_c() {
    let args = new_session_args(&Launch {
        context: Some("x"),
        prompt: Some("bonjour"),
        ..launch()
    });
    assert_eq!(args[0], "--no-daemon");
    let parsed = overrides(&args);
    assert_eq!(args.iter().filter(|a| *a == "-c").count(), parsed.len());
    let server = &parsed
        .iter()
        .find_map(|t| t.get("mcp_servers"))
        .expect("mcp server")["taido"];
    assert!(server.get("url").is_some() || server.get("env_http_headers").is_some());
    assert_eq!(args.last().map(String::as_str), Some("bonjour"));
}

#[test]
fn the_app_tools_need_no_approval() {
    let args = new_session_args(&launch());
    let approval = overrides(&args).into_iter().find_map(|t| {
        t.get("mcp_servers")?
            .get("taido")?
            .get("default_tools_approval_mode")?
            .as_str()
            .map(str::to_string)
    });
    assert_eq!(approval.as_deref(), Some("approve"));
}

#[test]
fn the_mcp_server_reads_token_and_terminal_from_the_environment() {
    let args = new_session_args(&launch());
    let parsed = overrides(&args);
    let url = parsed.iter().find_map(|t| {
        t.get("mcp_servers")?
            .get("taido")?
            .get("url")?
            .as_str()
            .map(str::to_string)
    });
    assert_eq!(url.as_deref(), Some("http://127.0.0.1:4242/mcp"));
    let headers = parsed
        .iter()
        .find_map(|t| {
            t.get("mcp_servers")?
                .get("taido")?
                .get("env_http_headers")
                .cloned()
        })
        .expect("headers");
    assert_eq!(headers["X-App-Token"].as_str(), Some("TAIDO_HOOK_TOKEN"));
    assert_eq!(headers["X-Terminal-Id"].as_str(), Some("TAIDO_TERMINAL_ID"));
}

#[test]
fn the_task_context_survives_quotes_backslashes_and_newlines() {
    let text = "Tâche : « dire \"bonjour\" »\nLigne 2 \\ fin\t";
    let args = new_session_args(&Launch {
        context: Some(text),
        ..launch()
    });
    let value = overrides(&args).into_iter().find_map(|t| {
        t.get("developer_instructions")?
            .as_str()
            .map(str::to_string)
    });
    assert_eq!(value.as_deref(), Some(text));
}

#[test]
fn a_prompt_starting_with_a_dash_stays_a_prompt() {
    let args = new_session_args(&Launch {
        prompt: Some("-v"),
        ..launch()
    });
    assert_eq!(args.last().map(String::as_str), Some(" -v"));
}

/// An untrusted folder makes Codex start read-only, and it then refuses `--add-dir` and
/// exits. It reads the attachments anyway (the path is in the context), so never pass it.
#[test]
fn codex_never_gets_add_dir_even_with_attachments() {
    let l = Launch {
        context: Some("- Attachments (readable):\n  - /Users/u/Taido/Pièces jointes/t1/a.png\n"),
        ..launch()
    };
    assert!(!new_session_args(&l).iter().any(|a| a == "--add-dir"));
    assert!(!resume_args("019a-real", &l)
        .iter()
        .any(|a| a == "--add-dir"));
}

#[test]
fn resume_names_the_conversation_and_keeps_the_settings() {
    let args = resume_args("019a-real", &launch());
    assert_eq!(&args[..3], ["resume", "019a-real", "--no-daemon"]);
    assert_eq!(
        args.iter().filter(|a| a.starts_with("hooks.")).count(),
        EVENTS.len()
    );
}

#[test]
fn launch_env_carries_the_hook_url() {
    assert_eq!(
        launch_env(4242),
        vec![(
            HOOK_URL_VAR.to_string(),
            "http://127.0.0.1:4242/hooks".to_string()
        )]
    );
}

#[cfg(unix)]
mod check {
    use super::*;
    use crate::agents::codex_check;
    use std::os::unix::fs::PermissionsExt;

    fn fake(dir: &Path, script: &str) -> std::path::PathBuf {
        let path = dir.join("codex");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn env() -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), "/usr/bin:/bin".into());
        env
    }

    #[test]
    fn logged_in_codex() {
        let dir = tempfile::tempdir().expect("dir");
        let bin = fake(
            dir.path(),
            r#"case "$1" in --version) echo "codex-cli 0.162.1";; login) echo "Logged in using ChatGPT" >&2;; esac"#,
        );
        let s = codex_check::check(Some(bin), &env(), std::time::Duration::from_secs(5));
        assert_eq!(s.version.as_deref(), Some("0.162.1"));
        assert_eq!(s.logged_in, Some(true));
        assert!(s.path.is_some());
    }

    #[test]
    fn logged_out_codex() {
        let dir = tempfile::tempdir().expect("dir");
        let bin = fake(
            dir.path(),
            r#"case "$1" in --version) echo "codex-cli 0.162.1";; login) echo "Not logged in" >&2; exit 1;; esac"#,
        );
        let s = codex_check::check(Some(bin), &env(), std::time::Duration::from_secs(5));
        assert_eq!(s.logged_in, Some(false));
    }

    #[test]
    fn missing_codex() {
        let s = codex_check::check(None, &env(), std::time::Duration::from_secs(5));
        assert_eq!((s.path, s.version, s.logged_in), (None, None, None));
    }
}

/// Codex gets no `--add-dir`: the context it receives must name the attachments.
#[test]
fn codex_context_lists_the_attachments() {
    let files = ["/Users/u/Taido/Pièces jointes/t1/a.png".to_string()];
    let context = crate::agents::claude::context_text(&crate::agents::claude::TaskContext {
        subject: None,
        parent: None,
        title: "T",
        description: "",
        subtasks: vec![],
        attachments: &files,
    });
    let args = new_session_args(&Launch {
        context: Some(&context),
        ..launch()
    });
    let instructions = overrides(&args)
        .into_iter()
        .find_map(|t| {
            t.get("developer_instructions")
                .and_then(|v| v.as_str().map(String::from))
        })
        .expect("developer_instructions");
    assert!(instructions.contains("/Users/u/Taido/Pièces jointes/t1/a.png"));
}
