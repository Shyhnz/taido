// Build of the installable web app for Android (docs/SYNC.md § 6.5):
// `pnpm build:mobile` → mobile/dist/ (index.html, assets/, manifest, icons, sw.js).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = resolve(import.meta.dirname, "mobile");
const publicDir = join(root, "public");

/** Every file under `dir`, as URL paths relative to `base`. */
function listFiles(dir: string, base: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path, base);
    return [`/${relative(base, path).split(sep).join("/")}`];
  });
}

/**
 * Emits dist/sw.js from mobile/sw.js with a `BUILD` hash and the `PRECACHE` list of every
 * emitted file (bundle + public dir), so each deploy changes the worker's bytes.
 */
function serviceWorker(): Plugin {
  return {
    name: "todo-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle)
        .filter((f) => !f.endsWith(".map") && f !== "index.html")
        .map((f) => `/${f}`);
      const publicFiles = listFiles(publicDir, publicDir);
      const precache = [
        "/",
        "/index.html",
        ...publicFiles.sort(),
        ...emitted.sort(),
      ];
      const hash = createHash("sha256");
      for (const f of emitted) hash.update(f);
      for (const f of publicFiles) {
        hash.update(f);
        hash.update(readFileSync(join(publicDir, f)));
      }
      const build = hash.digest("hex").slice(0, 16);
      const source = readFileSync(join(root, "sw.js"), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const BUILD = ${JSON.stringify(build)};\nconst PRECACHE = ${JSON.stringify(precache, null, 2)};\n${source}`,
      });
    },
  };
}

/**
 * Swaps the xterm module for src/mobile/xterm-stub.ts: the phone has no terminals, so
 * xterm.js and its addons stay out of the bundle (checked by mobile/check-dist.mjs).
 */
function noTerminals(): Plugin {
  const real = resolve(import.meta.dirname, "src/features/terminals/xterm.ts");
  const stub = resolve(import.meta.dirname, "src/mobile/xterm-stub.ts");
  return {
    name: "todo-no-terminals",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!source.endsWith("xterm") || !importer) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      return resolved?.id === real ? stub : null;
    },
  };
}

/**
 * Dev server only: mobile/index.html loads `../src/mobile/main.tsx`, outside the root, which
 * the dev server would look for as `mobile/src/…`. Point the script at the real file (`/@fs/`).
 */
function entryOutsideRoot(): Plugin {
  const entry = resolve(import.meta.dirname, "src/mobile/main.tsx")
    .split(sep)
    .join("/");
  return {
    name: "todo-entry-outside-root",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replace(
          'src="../src/mobile/main.tsx"',
          `src="/@fs${encodeURI(entry)}"`,
        ),
    },
  };
}

export default defineConfig({
  root,
  publicDir,
  plugins: [
    entryOutsideRoot(),
    noTerminals(),
    react(),
    tailwindcss(),
    serviceWorker(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 1430,
    proxy: {
      "/api": "http://127.0.0.1:3020",
    },
  },
});
