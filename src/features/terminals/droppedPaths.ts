/**
 * Files dropped on a terminal become their paths typed at the prompt, like Terminal.app and
 * iTerm2: shell-escaped, separated by spaces, with a trailing space. Claude Code reads a
 * dropped image path as an attached image.
 */

/** Characters a POSIX shell reads literally; every other one gets a backslash. */
const POSIX_UNSAFE = /[^\p{L}\p{N}_\-./,:+@%=~^]/gu;

/** `C:\…` or `\\server\…`: a Windows path, quoted instead of backslash-escaped. */
const WINDOWS_PATH = /^(?:[A-Za-z]:\\|\\\\)/;

function quotePath(path: string): string {
  if (WINDOWS_PATH.test(path))
    return /[\s&()^;,]/.test(path) ? `"${path}"` : path;
  return path.replace(POSIX_UNSAFE, "\\$&");
}

/** Text typed into the terminal for the dropped `paths` (empty when there are none). */
export function formatDroppedPaths(paths: string[]): string {
  if (paths.length === 0) return "";
  return `${paths.map(quotePath).join(" ")} `;
}
