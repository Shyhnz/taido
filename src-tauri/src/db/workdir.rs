//! Working folder of a task and its git branch.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::model::{Workdir, WorkdirSource};

const GIT_TIMEOUT: Duration = Duration::from_secs(1);

/// `workdir_override`, else `subject.root_path` + `section.subpath`, else `subject.root_path`.
/// `None` for an inbox task without override.
pub fn resolve(
    workdir_override: Option<&str>,
    subject_root: Option<&str>,
    section_subpath: Option<&str>,
) -> Option<Workdir> {
    let (path, source) = match (workdir_override, subject_root, section_subpath) {
        (Some(o), _, _) => (o.to_string(), WorkdirSource::Task),
        (None, Some(root), Some(sub)) if !sub.is_empty() => (
            Path::new(root).join(sub).to_string_lossy().into_owned(),
            WorkdirSource::Section,
        ),
        (None, Some(root), _) => (root.to_string(), WorkdirSource::Subject),
        (None, None, _) => return None,
    };
    let exists = Path::new(&path).exists();
    Some(Workdir {
        path,
        source,
        exists,
    })
}

/// Current branch via `git -C <dir> branch --show-current`, with a ~1 s timeout.
/// `None` when the folder is missing, git fails, the output is empty or it takes too long.
pub fn git_branch(dir: &str) -> Option<String> {
    if !Path::new(dir).is_dir() {
        return None;
    }
    let mut child = crate::env::hide_console(&mut Command::new("git"))
        .args(["-C", dir, "branch", "--show-current"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("git branch timed out or failed in {dir}");
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let branch = out.trim();
    (!branch.is_empty()).then(|| branch.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (override, subject root, section subpath, expected path and source)
    type Case = (
        Option<&'static str>,
        Option<&'static str>,
        Option<&'static str>,
        Option<(&'static str, WorkdirSource)>,
    );

    #[test]
    fn resolution_rules() {
        let cases: &[Case] = &[
            (None, None, None, None),
            (None, None, Some("ignored"), None),
            (Some("/o"), None, None, Some(("/o", WorkdirSource::Task))),
            (
                Some("/o"),
                Some("/r"),
                Some("s"),
                Some(("/o", WorkdirSource::Task)),
            ),
            (None, Some("/r"), None, Some(("/r", WorkdirSource::Subject))),
            (
                None,
                Some("/r"),
                Some(""),
                Some(("/r", WorkdirSource::Subject)),
            ),
            (
                None,
                Some("/r"),
                Some("web/app"),
                Some(("/r/web/app", WorkdirSource::Section)),
            ),
        ];
        for &(o, root, sub, expected) in cases {
            let got = resolve(o, root, sub).map(|w| (w.path, w.source));
            let expected = expected.map(|(p, s)| (p.to_string(), s));
            assert_eq!(got, expected, "{o:?} {root:?} {sub:?}");
        }
    }

    #[test]
    fn exists_reflects_the_filesystem() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_string_lossy().into_owned();
        assert!(resolve(None, Some(&root), None).expect("workdir").exists);
        assert!(
            !resolve(None, Some(&root), Some("missing"))
                .expect("workdir")
                .exists
        );
    }

    #[test]
    fn git_branch_none_outside_a_repo_or_missing_dir() {
        assert_eq!(git_branch("/definitely/not/here"), None);
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(git_branch(&dir.path().to_string_lossy()), None);
    }

    #[test]
    fn git_branch_of_a_fresh_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().into_owned();
        let ok = Command::new("git")
            .args(["init", "-q", "-b", "feature-x", &path])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            // git missing on this machine: nothing to check.
            return;
        }
        assert_eq!(git_branch(&path).as_deref(), Some("feature-x"));
    }
}
