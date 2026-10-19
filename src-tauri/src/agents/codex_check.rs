//! Codex check: `codex --version` and `codex login status` (exit status 0 = logged in; its
//! text, on stderr, is never read), run with argument arrays, stdin closed and a timeout.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use super::claude_check::{parse_version, run, run_status};
use crate::model::AgentStatus;

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
    // `codex-cli 0.162.1`
    let version = run(&bin, &["--version"], env, timeout).and_then(|out| parse_version(&out));
    let logged_in = run_status(&bin, &["login", "status"], env, timeout);
    AgentStatus {
        path: Some(bin.to_string_lossy().into_owned()),
        version,
        logged_in,
    }
}
