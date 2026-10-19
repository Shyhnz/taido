/**
 * Dashboard (Taido V2.5) on the mock backend: the figures follow the definitions, the tab
 * shows them, the list's strip opens it.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { commands } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { backend, taskWithFolder } from "../terminals/testSupport";

const main = () => screen.getByRole("main");

describe("dashboard", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
  });
  afterEach(() => backend().reset());

  it("counts open, done, overdue, blocked and time", async () => {
    const a = await taskWithFolder("Export PDF");
    const subjectId = a.subject?.id ?? null;
    const mk = (title: string, dueDate: string | null = null) =>
      commands.createTask({
        title,
        description: null,
        subjectId,
        sectionId: null,
        dueDate,
        dueTime: null,
      });
    const late = await mk("Corriger le fuseau", "2020-01-01");
    const done = await mk("Import CSV");
    const blocker = await mk("Modèle d'e-mail");
    await commands.addRelation({
      taskId: a.id,
      otherId: blocker.id,
      kind: "blocked_by",
    });
    await commands.setTaskCompleted({ id: done.id, completed: true });
    await commands.addManualTime({ taskId: done.id, minutes: 30, note: "" });
    const d = await commands.getDashboard(subjectId, 7);
    expect(d.open).toBe(3);
    expect(d.done).toBe(1);
    expect(d.overdue).toBe(1);
    expect([d.blocked, d.blockedByRelation, d.blockedWaiting]).toEqual([
      1, 1, 0,
    ]);
    expect(d.seconds).toBe(1800);
    expect(d.secondsPerDone).toBe(1800);
    expect(d.timeByDay).toHaveLength(7);
    expect(d.lateOrBlocked.map((t) => t.title)).toEqual([
      "Corriger le fuseau",
      "Export PDF",
    ]);
    expect(late.id).toBeTruthy();
  });

  it("shows the tab and opens it from the list's strip", async () => {
    const a = await taskWithFolder("Export PDF");
    await commands.addManualTime({ taskId: a.id, minutes: 45, note: "" });
    useUi
      .getState()
      .setView({ kind: "subject", subjectId: a.subject?.id ?? null });
    const user = userEvent.setup();
    render(<App />);
    const strip = await within(main()).findByRole("button", {
      name: /^Chiffres du projet/,
    });
    expect(strip).toHaveTextContent("45 min cette semaine");
    await user.click(strip);
    expect(useUi.getState().projectTab).toBe("dashboard");
    expect(await within(main()).findByText("Temps passé")).toBeInTheDocument();
    expect(within(main()).getAllByText("45 min").length).toBeGreaterThan(0);
    await user.click(within(main()).getByRole("button", { name: "30 jours" }));
    expect(
      await within(main()).findByText("Temps par tâche (30 j)"),
    ).toBeInTheDocument();
  });
});
