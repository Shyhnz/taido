import { describe, expect, it } from "vitest";
import type { SessionSummary, TerminalInfo } from "../../bindings";
import { terminalLabels } from "./terminalLabels";

const term = (id: string, kind: TerminalInfo["kind"]): TerminalInfo => ({
  id,
  taskId: "t",
  kind,
  command: kind === "command" ? "npm test" : null,
  cwd: "/tmp",
  openedAt: "2026-10-04T10:00:00.000Z",
  running: true,
  exitCode: null,
  agentSessionId: kind === "agent" ? `s-${id}` : null,
  agent: kind === "agent" ? "claude" : null,
});

const session = (id: string, firstPrompt: string | null): SessionSummary => ({
  id,
  agent: "claude",
  state: "idle",
  terminalId: null,
  startedAt: "2026-10-04T10:00:00.000Z",
  endedAt: null,
  firstPrompt,
  promptCount: firstPrompt ? 1 : 0,
  crashed: false,
  lastReply: null,
  title: null,
  aiSummary: null,
  resumable: false,
});

describe("terminal labels (option A)", () => {
  it("keeps « Claude Code » for a lone Claude", () => {
    const labels = terminalLabels(
      [term("a", "agent"), term("b", "shell")],
      [session("s-a", "refonte du panneau")],
    );
    expect(labels.get("a")).toBe("Claude Code");
    expect(labels.get("b")).toBe("Shell");
  });

  it("names two Claude terminals by their recap, else by a number", () => {
    const labels = terminalLabels(
      [term("a", "agent"), term("b", "agent"), term("c", "command")],
      [
        session("s-a", "Refais la barre du mode focus pour gagner de la place"),
        session("s-b", null),
      ],
    );
    expect(labels.get("a")).toBe("Claude · Refais la barre du mode foc…");
    expect(labels.get("b")).toBe("Claude Code 2");
    expect(labels.get("c")).toBe("npm test");
  });
});
