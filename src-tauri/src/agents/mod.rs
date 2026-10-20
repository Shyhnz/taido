//! The AI tools a task can run: one module per tool.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub mod claude;
pub mod claude_check;
pub mod codex;
pub mod codex_check;
pub mod usage;

/// The system whose conventions a lookup follows. Always [`Os::CURRENT`] in the app; tests
/// pass the other one to check Windows lookups on macOS and the reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Unix,
    Windows,
}

impl Os {
    pub const CURRENT: Os = if cfg!(windows) { Os::Windows } else { Os::Unix };
}

/// Where an agent's program is looked for.
pub struct BinarySpec {
    /// Program name without extension (`claude`): the file itself on macOS; `.exe`, then the
    /// npm shims `.cmd` and `.bat`, on Windows.
    pub name: &'static str,
    /// Usual install locations on macOS (`~` = home), after the `PATH` of the login shell.
    pub common_locations: &'static [&'static str],
    /// Usual install folders on Windows, as components under the home folder.
    pub windows_dirs: &'static [&'static [&'static str]],
}

/// The npm global folder on Windows (`npm install -g` puts `claude.cmd` there).
pub const WINDOWS_NPM_DIR: &[&str] = &["AppData", "Roaming", "npm"];

/// The binary to run, by priority:
///
/// 1. the development override (`TAIDO_CLAUDE_BIN`, `TAIDO_CODEX_BIN`: fakes);
/// 2. the explicit setting (Réglages › Agents);
/// 3. the name in the login shell's `PATH`, then the usual locations.
///
/// An override or a setting that is not an executable file gives `None` (« introuvable »):
/// never a silent fallback to another binary than the one asked for.
pub fn resolve_binary(
    spec: &BinarySpec,
    override_bin: Option<&str>,
    setting: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    resolve_binary_on(Os::CURRENT, spec, override_bin, setting, env)
}

/// [`resolve_binary`] with the conventions of `os`: on Windows `PATH` is `;`-separated and
/// a program is any file named `<name>.exe`, `<name>.cmd` or `<name>.bat`.
pub fn resolve_binary_on(
    os: Os,
    spec: &BinarySpec,
    override_bin: Option<&str>,
    setting: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let explicit = [override_bin, setting]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|b| !b.is_empty());
    if let Some(bin) = explicit {
        let path = PathBuf::from(bin);
        return is_executable(&path, os).then_some(path);
    }
    let home = crate::env::home_dir(env).unwrap_or_default();
    let names: Vec<String> = match os {
        Os::Unix => vec![spec.name.to_string()],
        Os::Windows => ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{}.{ext}", spec.name))
            .collect(),
    };
    let path = env.get("PATH").map(String::as_str).unwrap_or("");
    let path_dirs: Vec<PathBuf> = match os {
        Os::Unix => std::env::split_paths(path).collect(),
        Os::Windows => path
            .split(';')
            .map(|d| PathBuf::from(d.trim().trim_matches('"')))
            .collect(),
    };
    let common: Vec<PathBuf> = match os {
        Os::Unix => spec
            .common_locations
            .iter()
            .map(|p| PathBuf::from(p.replacen('~', home, 1)))
            .collect(),
        Os::Windows if home.is_empty() => Vec::new(),
        Os::Windows => spec
            .windows_dirs
            .iter()
            .flat_map(|parts| {
                let dir = parts.iter().fold(PathBuf::from(home), |d, p| d.join(p));
                names.iter().map(move |n| dir.join(n))
            })
            .collect(),
    };
    path_dirs
        .iter()
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .chain(common)
        .find(|p| is_executable(p, os))
}

/// The program and arguments that actually start `program args…` (a terminal or a question):
/// see [`launch_command_on`].
pub fn launch_command(
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> (String, Vec<String>) {
    launch_command_on(Os::CURRENT, program, args, env)
}

/// On Windows an npm shim (`codex.cmd`, `claude.cmd`) is skipped: its script runs with
/// `node` directly, so no argument goes through `cmd.exe` (Codex's `-c` values are full of
/// quotes). Any other batch file runs as is with [`crate::env::batch_safe_args`]. A real
/// program, and anything on macOS, is untouched.
pub fn launch_command_on(
    os: Os,
    program: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> (String, Vec<String>) {
    let lower = program.to_ascii_lowercase();
    if os != Os::Windows || !(lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        return (program.to_string(), args.to_vec());
    }
    let shim = Path::new(program);
    let script = shim.parent().and_then(|dir| {
        let text = std::fs::read_to_string(shim).ok()?;
        npm_shim_script(&text, dir).filter(|s| s.is_file())
    });
    let node = script.as_ref().and_then(|_| {
        let beside = shim.parent()?.join("node.exe");
        if beside.is_file() {
            return Some(beside);
        }
        env.get("PATH")
            .map(String::as_str)
            .unwrap_or("")
            .split(';')
            .map(|d| PathBuf::from(d.trim().trim_matches('"')))
            .filter(|d| !d.as_os_str().is_empty())
            .map(|d| d.join("node.exe"))
            .find(|p| p.is_file())
    });
    match (script, node) {
        (Some(script), Some(node)) => {
            let mut launched = vec![script.to_string_lossy().into_owned()];
            launched.extend(args.iter().cloned());
            (node.to_string_lossy().into_owned(), launched)
        }
        _ => (
            program.to_string(),
            crate::env::batch_safe_args(program, args),
        ),
    }
}

/// The script an npm shim (cmd-shim) runs: the last `"%dp0%\…"` of its line ending in `%*`,
/// `%dp0%` being the shim's folder `dir`.
fn npm_shim_script(text: &str, dir: &Path) -> Option<PathBuf> {
    const DP0: &str = "\"%dp0%\\";
    let line = text.lines().rev().find(|l| l.trim_end().ends_with("%*"))?;
    let start = line.rfind(DP0)? + DP0.len();
    let relative = &line[start..start + line[start..].find('"')?];
    if relative.is_empty() || relative.contains("..") || relative.contains('%') {
        return None;
    }
    Some(
        relative
            .split('\\')
            .filter(|p| !p.is_empty())
            .fold(dir.to_path_buf(), |d, p| d.join(p)),
    )
}

/// A file the system can run: with an execute bit on Unix, any file on Windows (where
/// running depends on the extension, checked by the lookup).
fn is_executable(path: &Path, os: Os) -> bool {
    match os {
        Os::Windows => path.is_file(),
        #[cfg(unix)]
        Os::Unix => {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        Os::Unix => path.is_file(),
    }
}

/// A fake agent of `tools/` (`fake-claude`, `fake-codex`) for the tests: the script itself,
/// on Windows its launcher `<name>.cmd` (npm's shim form, see [`launch_command_on`]).
#[cfg(test)]
pub fn fake_bin(name: &str) -> String {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tools")
        .join(name);
    let file = if cfg!(windows) {
        format!("{name}.cmd")
    } else {
        name.to_string()
    };
    dir.join(file).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{claude, claude_check, codex};

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, "@echo off\r\n").expect("write");
    }

    /// `PATH` of a Windows machine: `;`-separated, the npm folder after the system ones.
    fn windows_env(home: &Path, extra_path: &Path) -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "USERPROFILE".to_string(),
                home.to_string_lossy().into_owned(),
            ),
            (
                "PATH".to_string(),
                format!(
                    "C:\\Windows\\System32;\"{}\";C:\\Program Files\\nodejs\\",
                    extra_path.to_string_lossy()
                ),
            ),
        ])
    }

    #[test]
    fn agent_is_found_through_cmd_shim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("Jane Doe");
        let npm = home.join("AppData").join("Roaming").join("npm");
        touch(&npm.join("claude.cmd"));
        touch(&npm.join("codex.cmd"));
        let env = windows_env(&home, &npm);
        assert_eq!(
            resolve_binary_on(Os::Windows, &claude::BINARY, None, None, &env),
            Some(npm.join("claude.cmd"))
        );
        assert_eq!(
            resolve_binary_on(Os::Windows, &codex::BINARY, None, None, &env),
            Some(npm.join("codex.cmd"))
        );
        // A real program wins over the shim of the same folder.
        touch(&npm.join("claude.exe"));
        assert_eq!(
            resolve_binary_on(Os::Windows, &claude::BINARY, None, None, &env),
            Some(npm.join("claude.exe"))
        );
        // Not on PATH: the native installer's folder under the home folder.
        let local = home.join(".local").join("bin");
        touch(&local.join("claude.exe"));
        let mut no_path = env.clone();
        no_path.insert("PATH".into(), "C:\\Windows\\System32".into());
        assert_eq!(
            resolve_binary_on(Os::Windows, &claude::BINARY, None, None, &no_path),
            Some(local.join("claude.exe"))
        );
        assert_eq!(
            resolve_binary_on(Os::Windows, &codex::BINARY, None, None, &no_path),
            Some(npm.join("codex.cmd"))
        );
    }

    /// What `npm install -g` writes on Windows (cmd-shim), for `@openai/codex`.
    const NPM_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n\
:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  \
SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  \
SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || \
title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";

    #[test]
    fn npm_shim_runs_its_script_with_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let npm = dir.path().join("Jane Doe").join("npm");
        let shim = npm.join("codex.cmd");
        std::fs::create_dir_all(&npm).expect("mkdir");
        std::fs::write(&shim, NPM_SHIM).expect("write");
        let script = ["node_modules", "@openai", "codex", "bin", "codex.js"]
            .iter()
            .fold(npm.clone(), |d, p| d.join(p));
        touch(&script);
        let nodejs = dir.path().join("Program Files").join("nodejs");
        touch(&nodejs.join("node.exe"));
        let env = windows_env(dir.path(), &nodejs);
        let args = vec!["-c".to_string(), "a=\"b & c\"".to_string()];
        let shim_s = shim.to_string_lossy().into_owned();

        // node from PATH, the shim's script first, the arguments untouched.
        let (program, launched) = launch_command_on(Os::Windows, &shim_s, &args, &env);
        assert_eq!(PathBuf::from(&program), nodejs.join("node.exe"));
        assert_eq!(launched[0], script.to_string_lossy());
        assert_eq!(&launched[1..], args.as_slice());

        // The node next to the shim wins, as in the shim itself.
        touch(&npm.join("node.exe"));
        let (program, _) = launch_command_on(Os::Windows, &shim_s, &args, &env);
        assert_eq!(PathBuf::from(&program), npm.join("node.exe"));

        // Any other batch file runs as is, with arguments made safe for cmd.exe.
        let other = npm.join("other.cmd");
        std::fs::write(&other, "@echo off\r\nreal.exe %*\r\n").expect("write");
        let other_s = other.to_string_lossy().into_owned();
        let (program, launched) = launch_command_on(Os::Windows, &other_s, &args, &env);
        assert_eq!(program, other_s);
        assert_eq!(launched, crate::env::batch_safe_args(&other_s, &args));

        // A real program, or macOS: untouched.
        assert_eq!(
            launch_command_on(Os::Windows, "C:\\x\\claude.exe", &args, &env),
            ("C:\\x\\claude.exe".to_string(), args.clone())
        );
        assert_eq!(
            launch_command_on(Os::Unix, &shim_s, &args, &env),
            (shim_s.clone(), args.clone())
        );
    }

    #[test]
    fn the_fakes_windows_launchers_run_their_script_with_node() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nodejs = dir.path().join("nodejs");
        touch(&nodejs.join("node.exe"));
        let env = windows_env(dir.path(), &nodejs);
        let tools = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools");
        for name in ["fake-claude", "fake-codex"] {
            let shim = tools.join(name).join(format!("{name}.cmd"));
            let text = std::fs::read_to_string(&shim).expect("launcher");
            assert!(text.contains("\r\n"), "{name}.cmd needs CRLF line endings");
            let args = vec!["--x".to_string()];
            let (program, launched) =
                launch_command_on(Os::Windows, &shim.to_string_lossy(), &args, &env);
            assert_eq!(PathBuf::from(program), nodejs.join("node.exe"));
            assert_eq!(PathBuf::from(&launched[0]), tools.join(name).join(name));
            assert_eq!(&launched[1..], args.as_slice());
        }
    }

    #[test]
    fn missing_claude_shows_install_state() {
        let env = BTreeMap::from([
            ("USERPROFILE".to_string(), "C:\\Users\\Jane Doe".to_string()),
            (
                "PATH".to_string(),
                "C:\\Windows\\System32;C:\\Program Files\\nodejs\\".to_string(),
            ),
        ]);
        let bin = resolve_binary_on(Os::Windows, &claude::BINARY, None, None, &env);
        assert_eq!(bin, None);
        // The UI shows « install Claude Code » for a status without a path.
        let status = claude_check::check(bin, &env, claude_check::CHECK_TIMEOUT);
        assert_eq!(status.path, None);
        assert_eq!(status.version, None);
        assert_eq!(status.logged_in, None);
        // A setting pointing nowhere is « not found » too, never a crash.
        let set = resolve_binary_on(
            Os::Windows,
            &claude::BINARY,
            None,
            Some("C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd"),
            &env,
        );
        assert_eq!(set, None);
    }
}
