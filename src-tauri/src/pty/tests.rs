//! Real processes in real PTYs (`/bin/sh`, `cat`, `sleep`): no Claude involved.

use std::sync::mpsc;

use super::*;
use crate::model::TerminalKind;

fn info(id: &str) -> TerminalInfo {
    TerminalInfo {
        id: id.to_string(),
        task_id: "task-1".into(),
        kind: TerminalKind::Command,
        command: None,
        cwd: "/".into(),
        opened_at: format!("2026-10-03T10:00:00.000Z-{id}"),
        running: true,
        exit_code: None,
        agent_session_id: None,
        agent: None,
    }
}

fn sh(script: &str) -> SpawnSpec {
    let mut env = BTreeMap::new();
    env.insert("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into());
    env.insert("TERM".into(), "xterm-256color".into());
    SpawnSpec {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        cwd: std::env::temp_dir(),
        env,
        cols: 80,
        rows: 24,
    }
}

/// Manager whose exit hook forwards to a channel.
fn manager(buffer: usize) -> (PtyManager, mpsc::Receiver<TerminalInfo>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let hook: ExitHook = Arc::new(move |info: &TerminalInfo| {
        if let Ok(tx) = tx.lock() {
            let _ = tx.send(info.clone());
        }
    });
    (PtyManager::new(buffer, hook), rx)
}

/// Sink collecting into a shared buffer.
fn collector() -> (Sink, Arc<Mutex<Vec<u8>>>) {
    let data = Arc::new(Mutex::new(Vec::new()));
    let d = data.clone();
    let sink: Sink = Box::new(move |bytes| {
        d.lock().expect("lock").extend_from_slice(&bytes);
        true
    });
    (sink, data)
}

fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn text(data: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&data.lock().expect("lock")).into_owned()
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn replays_the_buffer_on_attach_and_reports_the_exit() {
    let (m, exits) = manager(DEFAULT_BUFFER_BYTES);
    m.spawn(info("t1"), sh("printf 'hello\\n'; exit 3"))
        .expect("spawn");
    let exited = exits.recv_timeout(Duration::from_secs(10)).expect("exit");
    assert_eq!(exited.id, "t1");
    assert_eq!(exited.exit_code, Some(3));
    assert!(!exited.running);
    // Exited terminals are kept (their tab stays) until removed.
    assert_eq!(m.info("t1").map(|i| i.running), Some(false));

    let (sink, data) = collector();
    wait_until("output buffered", || {
        let (probe, d) = collector();
        m.attach("t1", probe).is_ok() && text(&d).contains("hello")
    });
    m.attach("t1", sink).expect("attach");
    assert!(text(&data).contains("hello"));
}

#[test]
fn streams_input_echo_to_the_subscriber_without_gap_or_duplicate() {
    let (m, _exits) = manager(DEFAULT_BUFFER_BYTES);
    m.spawn(info("t2"), sh("stty -echo; echo ready; cat"))
        .expect("spawn");
    let (sink, data) = collector();
    m.attach("t2", sink).expect("attach");
    // Write once the terminal echo is off, so each line comes back once (from cat).
    wait_until("ready", || text(&data).contains("ready"));
    for i in 0..50 {
        m.write("t2", format!("line-{i}\n").as_bytes())
            .expect("write");
    }
    wait_until("all lines echoed", || text(&data).contains("line-49"));
    let out = text(&data);
    for i in 0..50 {
        assert_eq!(out.matches(&format!("line-{i}\r")).count(), 1, "line-{i}");
    }
    m.shutdown_all();
}

#[test]
fn a_large_output_keeps_only_the_buffer_tail() {
    let cap = 256 * 1024;
    let (m, exits) = manager(cap);
    // ~2.4 MB of numbered lines.
    m.spawn(info("t3"), sh("seq 1 400000")).expect("spawn");
    let started = Instant::now();
    exits.recv_timeout(Duration::from_secs(20)).expect("exit");
    let (sink, data) = collector();
    wait_until("tail buffered", || {
        let (probe, d) = collector();
        let _ = m.attach("t3", probe);
        text(&d).contains("400000")
    });
    m.attach("t3", sink).expect("attach");
    let out = data.lock().expect("lock").clone();
    assert!(out.len() <= cap);
    assert!(String::from_utf8_lossy(&out).trim_end().ends_with("400000"));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "too slow: {:?}",
        started.elapsed()
    );
}

#[test]
fn resize_reaches_the_process() {
    let (m, _exits) = manager(DEFAULT_BUFFER_BYTES);
    m.spawn(info("t4"), sh("read _; stty size; sleep 5"))
        .expect("spawn");
    m.resize("t4", 100, 30).expect("resize");
    let (sink, data) = collector();
    m.attach("t4", sink).expect("attach");
    m.write("t4", b"go\n").expect("write");
    wait_until("stty size", || text(&data).contains("30 100"));
    m.shutdown_all();
}

#[test]
fn shutdown_leaves_no_process_behind() {
    let (m, exits) = manager(DEFAULT_BUFFER_BYTES);
    // The shell ignores SIGTERM: SIGKILL after the grace period must still end it, and the
    // background sleep (same process group) must die too.
    m.spawn(
        info("t5"),
        sh("trap '' TERM; sleep 300 & echo child=$!; wait"),
    )
    .expect("spawn");
    m.spawn(info("t6"), sh("sleep 300")).expect("spawn");
    let (sink, data) = collector();
    m.attach("t5", sink).expect("attach");
    wait_until("child pid", || text(&data).contains("child="));
    let child: i32 = text(&data)
        .split("child=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .expect("child pid");
    assert!(alive(child));

    let started = Instant::now();
    m.shutdown_all();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "one shared grace period"
    );
    let mut ids: Vec<String> = (0..2)
        .map(|_| exits.recv_timeout(Duration::from_secs(5)).expect("exit").id)
        .collect();
    ids.sort();
    assert_eq!(ids, ["t5", "t6"]);
    wait_until("background child gone", || !alive(child));
    assert!(m.list().is_empty());
}

/// Background job of a shell with job control (own process group, like an interactive zsh):
/// it must not outlive the terminal.
#[test]
fn shutdown_reaches_jobs_in_their_own_process_group() {
    let (m, exits) = manager(DEFAULT_BUFFER_BYTES);
    m.spawn(info("t8"), sh("set -m; sleep 300 & echo job=$!; sleep 301"))
        .expect("spawn");
    let (sink, data) = collector();
    m.attach("t8", sink).expect("attach");
    wait_until("job pid", || text(&data).contains("job="));
    let job: i32 = text(&data)
        .split("job=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .expect("job pid");
    // SAFETY: reads the process group of the job.
    let pgid = unsafe { libc::getpgid(job) };
    assert_eq!(pgid, job, "the job leads its own process group");
    m.shutdown_all();
    exits.recv_timeout(Duration::from_secs(5)).expect("exit");
    wait_until("background job gone", || !alive(job));
}

/// Same with a real interactive zsh, which also ignores SIGTERM.
#[test]
fn shutdown_reaches_the_jobs_of_an_interactive_zsh() {
    if !std::path::Path::new("/bin/zsh").exists() {
        return;
    }
    let (m, exits) = manager(DEFAULT_BUFFER_BYTES);
    let mut spec = sh("");
    spec.program = "/bin/zsh".into();
    spec.args = vec!["-f".into(), "-i".into()];
    m.spawn(info("t9"), spec).expect("spawn");
    let (sink, data) = collector();
    m.attach("t9", sink).expect("attach");
    m.write("t9", b"sleep 300 & echo job=$!\n").expect("write");
    // The typed command is echoed (`job=$!`) before the real `job=<pid>` line.
    let parse_job = || -> Option<i32> {
        text(&data).split("job=").skip(1).find_map(|s| {
            let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
            // A digit run that ends the text may be cut short.
            (s.len() > digits.len())
                .then(|| digits.parse().ok())
                .flatten()
        })
    };
    wait_until("job pid", || parse_job().is_some());
    let job: i32 = parse_job().expect("job pid");
    assert!(alive(job));
    let started = Instant::now();
    m.shutdown_all();
    exits.recv_timeout(Duration::from_secs(5)).expect("exit");
    wait_until("background job gone", || !alive(job));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn remove_stops_a_running_terminal_and_forgets_it() {
    let (m, exits) = manager(DEFAULT_BUFFER_BYTES);
    m.spawn(info("t7"), sh("sleep 300")).expect("spawn");
    let removed = m.remove("t7").expect("removed");
    assert!(removed.running);
    assert!(m.info("t7").is_none());
    let exited = exits.recv_timeout(Duration::from_secs(5)).expect("exit");
    assert_eq!(exited.id, "t7");
    assert_eq!(exited.exit_code, None, "killed by a signal");
    assert!(matches!(m.write("t7", b"x"), Err(AppError::NotFound(_))));
}
