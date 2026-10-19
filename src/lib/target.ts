/**
 * Build target. The installable web app for Android (PWA) is the same React UI
 * built by `vite.mobile.config.ts` with `--mode mobile`; Vite replaces `import.meta.env.MODE`
 * at build time, so the desktop build drops the mobile-only branches. In Vitest the mode is
 * "test": mobile code is tested through its own modules (src/mobile/), not through this flag.
 */
export const IS_MOBILE: boolean = import.meta.env.MODE === "mobile";
