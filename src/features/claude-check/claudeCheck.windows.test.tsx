import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { resetUi } from "../../stores/ui";
import { launchAgent } from "../terminals/actions";
import { createFakeXterm, resetFakeTerms } from "../terminals/fakeXterm";
import { setXtermFactory } from "../terminals/registry";
import { setTerminalList } from "../terminals/terminalList";
import { backend, taskWithFolder } from "../terminals/testSupport";
import { resetClaudeCheck } from "./claudeCheck";

// This file runs as Windows: an npm or pnpm shim without node.exe reads as not installed.
vi.mock("../../lib/platform", async (original) => ({
  ...(await original<typeof import("../../lib/platform")>()),
  OS: "windows",
}));

describe("Claude Code check on Windows", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    resetClaudeCheck();
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
    setTerminalList([]);
  });

  it("says that an npm install needs Node.js too", async () => {
    const task = await taskWithFolder();
    backend().state.claude = { found: false, loggedIn: null };
    render(<App />);
    void launchAgent(task.id);
    const dialog = await screen.findByRole("dialog", {
      name: "Claude Code introuvable",
    });
    expect(dialog).toHaveTextContent("Node.js doit alors être installé aussi");
  });
});
