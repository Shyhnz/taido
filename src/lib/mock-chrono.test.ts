import { describe, expect, it } from "vitest";
import { type ChronoFacts, MockChrono } from "./mock-chrono";

const T0 = "2026-10-09T10:00:00.000Z";
const T1 = "2026-10-09T10:05:00.000Z";
const T2 = "2026-10-09T10:07:30.000Z";

function facts(
  state: ChronoFacts["sessions"][number]["state"],
  over: Partial<ChronoFacts> = {},
): ChronoFacts {
  return {
    taskOpen: true,
    sessions: [{ id: "s1", state }],
    countsWaiting: false,
    ...over,
  };
}

describe("MockChrono (like db::time_segments)", () => {
  it("runs while Claude works, pauses while it waits", () => {
    let n = 0;
    const c = new MockChrono(() => `seg-${++n}`);
    c.reconcile("t1", facts("starting"), T0);
    expect(c.chronoOf("t1")).toBeNull();
    c.reconcile("t1", facts("working"), T0);
    expect(c.chronoOf("t1")).toEqual({ seconds: 0, runningSince: T0 });
    c.reconcile("t1", facts("waiting"), T1);
    expect(c.chronoOf("t1")).toEqual({ seconds: 300, runningSince: null });
    expect(c.timeOf("t1").segments[0].stopReason).toBe("waiting");
    c.reconcile("t1", facts("working"), T1);
    c.reconcile("t1", facts("working", { taskOpen: false }), T2);
    expect(c.timeOf("t1").segments[0].stopReason).toBe("task_done");
    expect(c.chronoOf("t1")?.seconds).toBe(450);
  });

  it("counts the wait when the setting is on, and keeps manual time", () => {
    let n = 0;
    const c = new MockChrono(() => `seg-${++n}`);
    c.reconcile("t1", facts("waiting", { countsWaiting: true }), T0);
    expect(c.chronoOf("t1")?.runningSince).toBe(T0);
    c.addManual("t2", 15, " Appel ", T1);
    const time = c.timeOf("t2");
    expect(time.chrono.seconds).toBe(900);
    expect(time.segments[0]).toMatchObject({ source: "manual", note: "Appel" });
    expect(c.delete(time.segments[0].id, T2)).toBeDefined();
    expect(c.chronoOf("t2")).toBeNull();
    expect(c.delete(c.timeOf("t1").segments[0].id, T2)).toBeUndefined();
  });

  it("never stops nor touches a running segment pulled from a Mac (no session here)", () => {
    let n = 0;
    const c = new MockChrono(() => `seg-${++n}`);
    const pulled = {
      id: "mac-seg",
      taskId: "t1",
      agentSessionId: null,
      source: "auto" as const,
      startedAt: T0,
      endedAt: null,
      stopReason: null,
      note: "",
      createdAt: T0,
      deletedAt: null,
    };
    c.segments.push({ ...pulled });
    // The task is checked here, then a local session works and stops: only its own segment.
    expect(c.reconcile("t1", facts("working", { taskOpen: false }), T1)).toBe(
      false,
    );
    expect(c.reconcile("t1", facts("working"), T1)).toBe(true);
    expect(c.reconcile("t1", facts("paused"), T2)).toBe(true);
    expect(c.segments.find((x) => x.id === "mac-seg")).toEqual(pulled);
    expect(c.runningTaskIds()).toEqual([]);
    // Shown running from its start; a running segment cannot be deleted.
    expect(c.chronoOf("t1")).toEqual({ seconds: 150, runningSince: T0 });
    expect(c.delete("mac-seg", T2)).toBeUndefined();
  });

  it("« Arrêter » never ends a segment before its start (a device whose clock is behind)", () => {
    const c = new MockChrono(() => "x");
    c.segments.push({
      id: "mac-seg",
      taskId: "t1",
      agentSessionId: null,
      source: "auto",
      startedAt: T1,
      endedAt: null,
      stopReason: "waiting",
      note: "",
      createdAt: T1,
      deletedAt: null,
    });
    expect(c.stop("mac-seg", T0)).toMatchObject({
      endedAt: T1,
      stopReason: null,
    });
    // Already stopped: left as is.
    expect(c.stop("mac-seg", T2)?.endedAt).toBe(T1);
  });

  it("drops the segments of purged tasks", () => {
    let n = 0;
    const c = new MockChrono(() => `seg-${++n}`);
    c.addManual("t1", 5, "", T1);
    c.addManual("t2", 5, "", T1);
    c.dropTasks(new Set(["t1"]));
    expect(c.segments.map((x) => x.taskId)).toEqual(["t2"]);
    expect(c.segments[0].createdAt).toBe(T1);
  });
});
