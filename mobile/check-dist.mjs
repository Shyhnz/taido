// Checks the output of `pnpm build:mobile` (docs/SYNC.md § 6.5, § 9 D):
//   node mobile/check-dist.mjs
// - mobile/dist holds index.html, sw.js, manifest.webmanifest and the icons;
// - sw.js pre-caches every emitted file;
// - the built CSS holds a class used only under src/features/ (Tailwind scanned src/);
// - index.html has no inline script (CSP of the server, § 4.4).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const dist = join(import.meta.dirname, "dist");
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );

for (const f of [
  "index.html",
  "sw.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
]) {
  check(existsSync(join(dist, f)), `missing ${f}`);
}

const sw = readFileSync(join(dist, "sw.js"), "utf8");
const precache = JSON.parse(
  /const PRECACHE = (\[[\s\S]*?\]);/.exec(sw)?.[1] ?? "[]",
);
check(/^const BUILD = "[0-9a-f]{16}";/.test(sw), "sw.js has no BUILD hash");
for (const f of files(dist)) {
  const url = `/${relative(dist, f).split(sep).join("/")}`;
  if (url === "/sw.js" || url.endsWith(".map")) continue;
  check(precache.includes(url), `sw.js does not pre-cache ${url}`);
}

// `field-sizing-content` is only used by src/features/views/TaskEditor.tsx.
const css = files(join(dist, "assets"))
  .filter((f) => f.endsWith(".css"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
check(
  css.includes(".field-sizing-content"),
  "the CSS lacks .field-sizing-content (src/features not scanned)",
);

// The phone has no terminals: xterm.js must not be bundled (vite.mobile.config.ts).
const js = files(join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
check(!js.includes("xterm-helper-textarea"), "the bundle includes xterm.js");
check(!css.includes(".xterm"), "the CSS includes xterm.css");

const html = readFileSync(join(dist, "index.html"), "utf8");
check(
  !/<script(?![^>]*\bsrc=)[^>]*>/.test(html),
  "index.html has an inline script",
);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`mobile/dist OK (${precache.length} pre-cached files)`);
