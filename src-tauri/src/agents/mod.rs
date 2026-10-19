//! The AI tools a task can run: one module per tool.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub mod claude;
pub mod claude_check;
pub mod codex;
pub mod codex_check;
pub mod usage;

/// Where an agent's program is looked for.
pub struct BinarySpec {
    /// File name in a `PATH` folder.
    pub name: &'static str,
    /// Usual install locations (`~` = home), after the `PATH` of the login shell.
    pub common_locations: &'static [&'static str],
}

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
    let explicit = [override_bin, setting]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|b| !b.is_empty());
    if let Some(bin) = explicit {
        let path = PathBuf::from(bin);
        return is_executable(&path).then_some(path);
    }
    let home = crate::env::home_dir(env).unwrap_or_default();
    let from_path = env
        .get("PATH")
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(spec.name));
    let common = spec
        .common_locations
        .iter()
        .map(|p| PathBuf::from(p.replacen('~', home, 1)));
    from_path.chain(common).find(|p| is_executable(p))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}
