/**
 * « Portefeuille » (Taido V2.6) on the mock backend: one line per project (groups aside),
 * sortable, a project opens its dashboard, the CSV export.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { commands } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { backend } from "../terminals/testSupport";

const main = () => screen.getByRole("main");

const project = async (name: string) =>
  (
    await commands.createSubject({
      name,
      color: null,
      rootPath: null,
      parentId: null,
    })
  ).id;

const task = (title: string, subjectId: string, dueDate: string | null) =>
  commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId: null,
    dueDate,
    dueTime: null,
  });

describe("portfolio", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
  });
  afterEach(() => backend().reset());

  it("lists every project, sorts, opens a dashboard and exports", async () => {
    const peak = await project("Summit Events");
    const admin = await project("Admin");
    await commands.groupProjects({
      projectIds: [admin],
      groupId: null,
      name: "Globex",
    });
    await task("Modèle d'e-mail", peak, "2099-01-13");
    await task("Facture", admin, "2099-01-05");
    await task("Sans date", admin, null);
    const p = await commands.getPortfolio(7);
    // Sidebar order: the new group took Admin's place, after Summit Events.
    expect(p.rows.map((r) => [r.name, r.group])).toEqual([
      ["Summit Events", null],
      ["Admin", "Globex"],
    ]);
    expect(p.open).toBe(3);

    useUi.getState().setView({ kind: "portfolio", subjectId: null });
    const user = userEvent.setup();
    render(<App />);
    const table = await within(main()).findByRole("table");
    const names = () =>
      within(table)
        .getAllByRole("rowheader")
        .map((h) => h.textContent);
    // By default: the nearest next due task first.
    expect(names()).toEqual(["Globex › Admin", "Summit Events"]);
    await user.click(within(table).getByRole("button", { name: "Ouvertes" }));
    expect(names()).toEqual(["Globex › Admin", "Summit Events"]);
    await user.click(within(table).getByRole("button", { name: /^Projet/ }));
    expect(names()).toEqual(["Globex › Admin", "Summit Events"]);
    await user.click(within(table).getByRole("button", { name: /^Projet/ }));
    expect(names()).toEqual(["Summit Events", "Globex › Admin"]);
    await user.click(
      within(main()).getByRole("button", { name: /Exporter les temps/ }),
    );
    expect(
      await screen.findByText(
        /Temps exportés : \/Users\/user\/Documents\/taido-temps-7j-/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(table).getByRole("button", { name: /Summit Events/ }),
    );
    expect(useUi.getState().view).toEqual({ kind: "subject", subjectId: peak });
    expect(useUi.getState().projectTab).toBe("dashboard");
  });
  it("a task re-sent at the epoch stamp keeps its real dates (web app)", async () => {
    const peak = await project("Summit Events");
    const { id } = await task("Ancienne", peak, null);
    const rec = backend().state.tasks.find((t) => t.id === id);
    if (!rec) throw new Error("task not found");
    // A Mac linking its data sends every row at the epoch stamp (docs/SYNC.md § 2.6).
    rec.updatedAt = "1970-01-01T00:00:00.000Z";
    rec.createdAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const row = (await commands.getPortfolio(7)).rows[0];
    expect(row.lastActivity).toBe(rec.createdAt);
    expect(row.inactiveDays).toBeNull();
  });
});
