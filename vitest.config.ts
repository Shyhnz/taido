import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "tools/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    css: false,
    // Shared CI runners are slow: give UI tests more room than the 5 s default.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
});
