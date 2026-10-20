//! Paths as each system reads them: Windows paths compare without regard to case or to the
//! slash used, and `canonicalize` there returns `\\?\C:\…` paths that are never shown as such.

use std::path::{Path, PathBuf};

/// `path` without Windows' verbatim prefix: `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\x` → `\\srv\x`.
/// Pure: any other path is returned as it is.
pub fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// `canonicalize`, without the verbatim prefix on Windows (shown and compared paths).
pub fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    let real = path.canonicalize()?;
    if cfg!(windows) {
        Ok(PathBuf::from(strip_verbatim(&real.to_string_lossy())))
    } else {
        Ok(real)
    }
}

/// The rest of `path` after the folder `root` (`""` for `root` itself), `None` when `path` is
/// not inside it. Windows: case-insensitive, `/` and `\` alike; elsewhere component by
/// component, as `Path::strip_prefix`.
pub fn relative_to(path: &str, root: &str, windows: bool) -> Option<String> {
    if root.is_empty() {
        return None;
    }
    if !windows {
        return Path::new(path)
            .strip_prefix(Path::new(root))
            .ok()
            .map(|rel| rel.to_string_lossy().into_owned());
    }
    let is_sep = |c: char| c == '\\' || c == '/';
    let same = |a: char, b: char| (is_sep(a) && is_sep(b)) || a.to_lowercase().eq(b.to_lowercase());
    let root = root.trim_end_matches(is_sep);
    let mut rest = path.char_indices();
    for r in root.chars() {
        match rest.next() {
            Some((_, p)) if same(p, r) => {}
            _ => return None,
        }
    }
    match rest.next() {
        None => Some(String::new()),
        Some((at, c)) if is_sep(c) => Some(
            path[at + c.len_utf8()..]
                .trim_start_matches(is_sep)
                .to_string(),
        ),
        Some(_) => None,
    }
}

/// [`relative_to`] with this system's rules.
pub fn relative(path: &str, root: &str) -> Option<String> {
    relative_to(path, root, cfg!(windows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_compare_without_case_and_slash() {
        let root = "C:\\Users\\Jane Doe";
        assert_eq!(
            relative_to("c:\\users\\jane doe\\x", root, true).as_deref(),
            Some("x")
        );
        assert_eq!(
            relative_to(
                "C:/Users/Jane Doe/src/app.ts",
                "C:\\Users\\Jane Doe\\",
                true
            )
            .as_deref(),
            Some("src/app.ts")
        );
        assert_eq!(
            relative_to("C:\\Users\\JANE DOE", root, true).as_deref(),
            Some("")
        );
        assert_eq!(relative_to("C:\\Users\\Jane Doe2\\x", root, true), None);
        assert_eq!(relative_to("D:\\Users\\Jane Doe\\x", root, true), None);
        assert_eq!(relative_to("C:\\x", "", true), None);
    }

    #[test]
    fn unix_paths_are_unchanged() {
        assert_eq!(
            relative_to("/a/b/c.txt", "/a/b", false).as_deref(),
            Some("c.txt")
        );
        assert_eq!(
            relative_to("/a/b/c.txt", "/a/b/", false).as_deref(),
            Some("c.txt")
        );
        assert_eq!(relative_to("/A/b/c", "/a/b", false), None);
        assert_eq!(relative_to("/a/bc/d", "/a/b", false), None);
        assert_eq!(
            relative_to("c:\\users\\jane doe\\x", "C:\\Users\\Jane Doe", false),
            None
        );
    }

    #[test]
    fn verbatim_prefix_is_never_shown() {
        assert_eq!(
            strip_verbatim("\\\\?\\C:\\Users\\Jane Doe"),
            "C:\\Users\\Jane Doe"
        );
        assert_eq!(
            strip_verbatim("\\\\?\\UNC\\srv\\share\\x"),
            "\\\\srv\\share\\x"
        );
        assert_eq!(strip_verbatim("C:\\x"), "C:\\x");
        assert_eq!(strip_verbatim("/Users/jane"), "/Users/jane");
    }
}
