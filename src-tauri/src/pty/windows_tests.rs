//! Real PowerShell in a real ConPTY (Windows only): the « Terminal » of a task.

use std::sync::mpsc;

use super::*;
use crate::model::TerminalKind;

fn info(id: &str, cwd: &std::path::Path) -> TerminalInfo {
    TerminalInfo {
        id: id.to_string(),
        task_id: "task-1".into(),
        kind: TerminalKind::Shell,
        command: None,
        cwd: cwd.to_string_lossy().into_owned(),
        opened_at: format!("2026-10-03T10:00:00.000Z-{id}"),
        running: true,
        exit_code: None,
        agent_session_id: None,
        agent: None,
    }
}

/// PowerShell as a « Terminal » runs it, in `cwd`, with the app's environment.
fn powershell(cwd: &std::path::Path, args: &[&str]) -> SpawnSpec {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    SpawnSpec {
        program: crate::env::terminal_shell(&env),
        args: args.iter().map(|a| a.to_string()).collect(),
        cwd: cwd.to_path_buf(),
        env,
        cols: 200,
        rows: 40,
    }
}

fn manager() -> (PtyManager, mpsc::Receiver<TerminalInfo>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let hook: ExitHook = Arc::new(move |info: &TerminalInfo| {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(info.clone());
        }
    });
    (PtyManager::new(DEFAULT_BUFFER_BYTES, hook), rx)
}

fn collector() -> (Sink, Arc<Mutex<Vec<u8>>>) {
    let data = Arc::new(Mutex::new(Vec::new()));
    let d = data.clone();
    let sink: Sink = Box::new(move |bytes| {
        d.lock().expect("lock").extend_from_slice(&bytes);
        true
    });
    (sink, data)
}

fn wait_until(what: &str, data: &Arc<Mutex<Vec<u8>>>, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let text = String::from_utf8_lossy(&data.lock().expect("lock")).into_owned();
        if text.contains(needle) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}: {text}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_command_runs_in_a_folder_with_spaces_and_reports_its_exit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().join("Jane Doe Project");
    std::fs::create_dir(&cwd).expect("mkdir");
    let (m, exits) = manager();
    m.spawn(
        info("w1", &cwd),
        powershell(
            &cwd,
            &[
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Write-Output ('in:' + (Split-Path -Leaf (Get-Location).Path)); exit 3",
            ],
        ),
    )
    .expect("spawn");
    let (sink, data) = collector();
    m.attach("w1", sink).expect("attach");
    let exited = exits.recv_timeout(Duration::from_secs(30)).expect("exit");
    assert_eq!(exited.exit_code, Some(3));
    wait_until("folder name", &data, "in:Jane Doe Project");
}

#[test]
fn typing_and_resizing_reach_an_interactive_powershell() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (m, exits) = manager();
    m.spawn(
        info("w2", dir.path()),
        powershell(dir.path(), &["-NoLogo", "-NoProfile"]),
    )
    .expect("spawn");
    let (sink, data) = collector();
    m.attach("w2", sink).expect("attach");
    m.write("w2", b"Write-Output ('ok-' + 6*7)\r")
        .expect("write");
    wait_until("typed command", &data, "ok-42");
    m.resize("w2", 123, 40).expect("resize");
    m.write(
        "w2",
        b"Write-Output ('w-' + $Host.UI.RawUI.WindowSize.Width)\r",
    )
    .expect("write");
    wait_until("new width", &data, "w-123");
    m.shutdown_all();
    let exited = exits.recv_timeout(Duration::from_secs(30)).expect("exit");
    assert!(!exited.running);
}

#[test]
fn user_text_cannot_run_commands_through_a_batch_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    // A space in the folder, like a profile `C:\Users\Jane Doe`: the quotes get shifted.
    let tools = dir.path().join("Jane Doe");
    std::fs::create_dir(&tools).expect("mkdir");
    // Not an npm shim: it runs through cmd.exe with its arguments.
    let script = tools.join("run.cmd");
    std::fs::write(&script, "@echo off\r\necho args: %*\r\n").expect("script");
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let spec = SpawnSpec {
        program: script.to_string_lossy().into_owned(),
        args: vec![
            "--name".into(),
            "a & echo pwned> p.txt".into(),
            "b\" & echo pwned2> p2.txt".into(),
        ],
        cwd: tools.clone(),
        env,
        cols: 200,
        rows: 40,
    };
    let (m, exits) = manager();
    m.spawn(info("w3", &tools), spec).expect("spawn");
    let (sink, data) = collector();
    m.attach("w3", sink).expect("attach");
    exits.recv_timeout(Duration::from_secs(30)).expect("exit");
    wait_until("the script's echo", &data, "args:");
    assert!(!tools.join("p.txt").exists(), "a command ran");
    assert!(!tools.join("p2.txt").exists(), "a command ran");
}
