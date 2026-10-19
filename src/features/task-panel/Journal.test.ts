import { describe, expect, it } from "vitest";
import type { JournalEntry, JournalKind } from "../../bindings";
import { taskEntries } from "./Journal";

const entry = (kind: JournalKind): JournalEntry => ({
  id: kind,
  taskId: "t",
  agentSessionId: null,
  agent: null,
  kind,
  text: "",
  at: "2026-10-03T10:00:00.000Z",
});

describe("task « Historique »", () => {
  it("keeps the life of the task, not what happens in Claude sessions", () => {
    const all: JournalKind[] = [
      "created",
      "note",
      "session_started",
      "prompt",
      "turn_ended",
      "waiting",
      "error",
      "session_ended",
      "crashed",
      "resumed",
      "cleared",
      "compacted",
      "completed",
      "reopened",
    ];
    expect(taskEntries(all.map(entry)).map((e) => e.kind)).toEqual([
      "created",
      "note",
      "completed",
      "reopened",
    ]);
  });
});
