import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "tools/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    css: false,
  },
});
