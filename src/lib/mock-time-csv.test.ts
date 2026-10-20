import { describe, expect, it } from "vitest";
import type { SegmentRec } from "./mock-chrono";
import { timeCsv } from "./mock-time-csv";

const now = new Date(2026, 9, 9, 15, 0, 0);

function segment(over: Partial<SegmentRec>): SegmentRec {
  return {
    id: "s1",
    taskId: "t1",
    agentSessionId: null,
    source: "auto",
    startedAt: new Date(2026, 9, 9, 10, 0, 0).toISOString(),
    endedAt: new Date(2026, 9, 9, 11, 30, 0).toISOString(),
    stopReason: "turn_ended",
    note: "",
    deletedAt: null,
    ...over,
  };
}

const task =
  (project: string | null, title = "Write, then ship") =>
  () => ({
    title,
    project,
  });

describe("time export of the web app, like the core's", () => {
  it("English: comma, English labels, Inbox", () => {
    const csv = timeCsv([segment({})], task(null), 30, now, "en");
    const [header, line] = csv.split("\r\n");
    expect(header).toBe(
      "\u{feff}Project,Task,Start,End,Duration,Duration (min),Source,Stop reason,Note",
    );
    expect(line).toBe(
      'Inbox,"Write, then ship",2026-10-09 10:00,2026-10-09 11:30,1:30:00,90,Claude,Claude is done,',
    );
  });

  it("English labels for a running segment, by hand and every stop reason", () => {
    const running = timeCsv(
      [segment({ endedAt: null, stopReason: null, source: "manual" })],
      task("Home"),
      30,
      now,
      "en",
    );
    expect(running).toContain("Home,");
    expect(running).toContain(",running,");
    expect(running).toContain(",by hand,");
    const reasons = (
      ["waiting", "session_closed", "task_done", "app_closed"] as const
    ).map(
      (r) =>
        timeCsv([segment({ stopReason: r })], task("P", "Ship"), 30, now, "en")
          .trim()
          .split("\r\n")[1]
          .split(",")[7],
    );
    expect(reasons).toEqual([
      "waiting for you",
      "session closed",
      "task completed",
      "Taido closed",
    ]);
  });

  it("French: semicolon, French labels, Sans projet", () => {
    const csv = timeCsv(
      [segment({})],
      task(null, "Écrire, puis livrer"),
      30,
      now,
      "fr",
    );
    const [header, line] = csv.split("\r\n");
    expect(header).toBe(
      "\u{feff}Projet;Tâche;Début;Fin;Durée;Durée (min);Source;Raison d'arrêt;Note",
    );
    expect(line).toBe(
      "Sans projet;Écrire, puis livrer;2026-10-09 10:00;2026-10-09 11:30;1:30:00;90;Claude;Claude a fini;",
    );
  });

  it("quotes a field that holds the separator of its language", () => {
    const fr = timeCsv([segment({})], task("P", "a;b"), 30, now, "fr");
    expect(fr).toContain('P;"a;b";');
  });
});
