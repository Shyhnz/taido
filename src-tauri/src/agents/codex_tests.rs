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
        add_dir: None,
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
        assert!(
            h.contains("timeout = 3"),
            "Codex clamps some hooks to 3 s: {h}"
        );
    }
}

#[test]
fn windows_hooks_go_through_powershell() {
    use crate::agents::Os;
    use base64::Engine as _;
    let handler = |os: Os| -> toml::Table {
        let table = toml::from_str::<toml::Table>(&hook_override("Stop", os)).expect("toml");
        table["hooks"]["Stop"][0]["hooks"][0]
            .as_table()
            .expect("handler")
            .clone()
    };
    let unix = handler(Os::Unix);
    // macOS: the same text as before (a changed hook asks for a new trust).
    assert!(!unix.contains_key("command_windows"), "{unix:?}");
    let win = handler(Os::Windows);
    assert_eq!(win["command"], unix["command"]);
    let command = win["command_windows"].as_str().expect("command_windows");
    let encoded = command
        .strip_prefix("powershell.exe -NoProfile -NonInteractive -EncodedCommand ")
        .expect("powershell");
    // Only base64 characters: nothing any shell (cmd, PowerShell, sh) would interpret.
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
    // The launch uses this system's form.
    let args = new_session_args(&launch());
    assert!(args.contains(&hook_override("Stop", Os::CURRENT)));
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

#[test]
fn attachments_folder_is_added() {
    let args = new_session_args(&Launch {
        add_dir: Some(Path::new("/Users/u/Taido/Pièces jointes/t1")),
        ..launch()
    });
    let i = args
        .iter()
        .position(|a| a == "--add-dir")
        .expect("--add-dir");
    assert_eq!(args[i + 1], "/Users/u/Taido/Pièces jointes/t1");
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
