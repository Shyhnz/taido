import { describe, expect, it } from "vitest";
import { frenchIn } from "../test/french";
import { en, enHelpers } from "./en";
import { fr } from "./fr";

type Walked = { path: string; value: unknown };

function walk(value: unknown, path = ""): Walked[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => walk(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      walk(v, path ? `${path}.${k}` : k),
    );
  }
  return [{ path, value }];
}

/** Shape of a table: every leaf path, with `fn/<arity>` for a function. */
const shape = (value: unknown) =>
  walk(value).map(({ path, value: v }) =>
    typeof v === "function"
      ? `${path}: fn/${v.length}`
      : `${path}: ${typeof v}`,
  );

const RINGS = [
  "human",
  "completed",
  "starting",
  "working",
  "waiting",
  "done",
  "idle",
  "paused",
  "error",
  "crashed",
];
const STOPS = [
  "waiting",
  "turn_ended",
  "session_closed",
  "task_done",
  "app_closed",
];
/** Values tried at each position of a function, the others staying on a base. */
const POOL: unknown[] = [
  0,
  1,
  2,
  5,
  -3,
  1500,
  2_000_000,
  "Globex",
  "Client",
  "/tmp/x",
  null,
  true,
  false,
  "claude",
  "codex",
  ...RINGS,
  ...STOPS,
];
const BASES: unknown[] = [1, 2, "Globex", "claude", "codex", null];

/** Every string a function returns for sample arguments (an argument it cannot take is skipped). */
function outputs(fn: (...args: unknown[]) => unknown): string[] {
  const out: string[] = [];
  const arity = Math.max(fn.length, 1);
  const keep = (r: unknown) => {
    for (const { value } of walk(r)) {
      if (typeof value === "string") out.push(value);
    }
  };
  for (const base of BASES) {
    for (let p = 0; p < arity; p++) {
      for (const v of POOL) {
        const args = Array.from({ length: arity }, (_, i) =>
          i === p ? v : base,
        );
        try {
          keep(fn(...args));
        } catch {
          // Not a value this function takes.
        }
      }
    }
  }
  return out;
}

function leftovers(table: unknown): string[] {
  const found: string[] = [];
  for (const { path, value } of walk(table)) {
    const texts =
      typeof value === "string"
        ? [value]
        : typeof value === "function"
          ? outputs(value as (...args: unknown[]) => unknown)
          : [];
    for (const text of texts) {
      const hit = frenchIn(text);
      if (hit) found.push(`${path} (${hit}): ${text}`);
    }
  }
  return [...new Set(found)];
}

describe("the English table", () => {
  it("en has exactly the keys of fr", () => {
    expect(shape(en)).toEqual(shape(fr));
  });

  it("the Codex guide has the shape of Claude's", () => {
    // The Codex guide's functions are wrappers (no declared arity), in French too.
    const keys = (value: unknown) => walk(value).map((w) => w.path);
    expect(keys(enHelpers.tutorialTexts("codex"))).toEqual(
      keys(enHelpers.tutorialTexts("claude")),
    );
    expect(shape(enHelpers.tutorialTexts("claude"))).toEqual(
      shape(fr.tutorial),
    );
  });

  it("en has no French leftovers", () => {
    expect(leftovers(en)).toEqual([]);
  });

  it("nor do its helpers (agent errors, both guides)", () => {
    expect(
      leftovers({
        claudeGuide: enHelpers.tutorialTexts("claude"),
        codexGuide: enHelpers.tutorialTexts("codex"),
        errors: [
          "rate_limit",
          "overloaded",
          "authentication_failed",
          "billing_error",
          "model_not_found",
          null,
        ].map((kind) => enHelpers.agentErrorLabel(kind)),
      }),
    ).toEqual([]);
  });

  it("reads naturally where it matters most", () => {
    expect(en.sidebar.noProject).toBe("Inbox");
    expect(en.sidebar.today).toBe("Today");
    expect(en.sidebar.upcoming).toBe("Upcoming");
    expect(en.common.tasks(0)).toBe("No tasks");
    expect(en.common.tasks(1)).toBe("1 task");
    expect(en.common.tasks(3)).toBe("3 tasks");
    expect(en.line.waiting_input(null, "claude")).toBe(
      "Claude is waiting for you",
    );
    expect(en.line.done(null, "codex")).toBe("Codex is done");
    expect(en.ring.state("working", "claude")).toBe("Claude is working");
    expect(enHelpers.agentErrorLabel("rate_limit")).toBe("Usage limit reached");
    expect(enHelpers.agentErrorLabel("model_not_found")).toBe(
      "Error: model_not_found",
    );
  });

  it("writes units the English way, and reads naturally", () => {
    expect(en.dates.hoursAgo(3)).toBe("3h ago");
    expect(en.sessions.durationHours(1, 5)).toBe("1h 05m");
    expect(en.dashboard.oldestValue(7)).toBe("7d");
    expect(en.dashboard.late(3)).toBe("3d late");
    expect(en.dashboard.age(3)).toBe("open for 3d");
    expect(en.portfolio.inactive(3)).toBe("inactive 3d");
    expect(en.portfolio.done(7)).toBe("Completed (7d)");
    for (const text of [
      en.row.menuFile,
      en.move.fileTitle,
      en.panel.locationMenu,
      en.list.file,
    ]) {
      expect(text).toBe("Move to project…");
    }
    expect(en.relations.showSubtasks(1, "Ship")).toBe(
      "Show 1 subtask of “Ship”",
    );
    expect(en.relations.showSubtasks(3, "Ship")).toBe(
      "Show the 3 subtasks of “Ship”",
    );
    expect(en.account.privacy).toContain("It never keeps your folders");
  });

  it("says the same about the account on the computer and the phone", () => {
    expect(en.account.privacy).toBe(en.sync.privacy);
  });

  it("the Codex guide names Codex, not Claude", () => {
    const codex = enHelpers.tutorialTexts("codex");
    expect(codex.claude.missing).toContain("@openai/codex");
    expect(JSON.stringify(walk(codex))).not.toContain("Claude");
  });
});
