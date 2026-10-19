// Layout C of the task panel (2026-10-11): folded sections with a summary, empty ones
// on the « Ajouter : … » line, a short chrono journal, « Bloquée par » under the title.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { fr } from "../../i18n/fr";
import { mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { openFold } from "../../test/panelFolds";
import { SEGMENTS_SHOWN } from "../chrono/ChronoSection";
import { PANEL_FOLDS_KEY } from "./PanelFold";
import { SUBTASKS_OPEN_MAX } from "./Subtasks";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const createTask = (title: string) =>
  backend().commands.createTask({
    title,
    description: null,
    subjectId: null,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });

async function openPanel(taskId: string) {
  act(() => useUi.getState().openTask(taskId));
  const panel = await screen.findByRole("region", { name: fr.panel.label });
  await within(panel).findByRole("textbox", { name: fr.panel.titleLabel });
  return panel;
}

const addLine = (panel: HTMLElement) =>
  within(panel).getByText(fr.folds.addLabel).parentElement as HTMLElement;

describe("task panel, layout C", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
    window.localStorage.clear();
  });

  it("offers the empty sections on one line and opens one in place", async () => {
    const task = await createTask("Vide");
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);

    const line = addLine(panel);
    for (const label of Object.values(fr.folds.add)) {
      expect(within(line).getByRole("button", { name: label })).toBeVisible();
    }
    expect(
      within(panel).queryByRole("region", { name: fr.relations.title }),
    ).toBeNull();

    // « Temps » opens the chrono with the hand-entry form ready.
    await user.click(
      within(line).getByRole("button", { name: fr.folds.add.chrono }),
    );
    const chrono = await within(panel).findByRole("region", {
      name: fr.chrono.title,
    });
    expect(
      within(chrono).getByRole("textbox", { name: fr.chrono.manualMinutes }),
    ).toHaveFocus();
    expect(
      within(addLine(panel)).queryByRole("button", {
        name: fr.folds.add.chrono,
      }),
    ).toBeNull();
  });

  it("folds a long subtask list and remembers what the user opened", async () => {
    const task = await createTask("Longue liste");
    for (let i = 0; i <= SUBTASKS_OPEN_MAX; i++) {
      await backend().commands.addSubtask({
        taskId: task.id,
        text: `Étape ${i}`,
      });
    }
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);

    const section = within(panel).getByRole("region", {
      name: fr.panel.subtasks,
    });
    const toggle = within(section).getByRole("button", {
      name: /^Sous-tâches/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(`0/${SUBTASKS_OPEN_MAX + 1}`);
    expect(within(panel).queryByRole("checkbox")).toBeNull();

    await user.click(toggle);
    expect(within(panel).getAllByRole("checkbox")).toHaveLength(
      SUBTASKS_OPEN_MAX + 1,
    );
    expect(
      JSON.parse(window.localStorage.getItem(PANEL_FOLDS_KEY) ?? "{}"),
    ).toEqual({ subtasks: true });
  });

  it("shows the last chrono lines and the rest on demand", async () => {
    const task = await createTask("Facture");
    const total = SEGMENTS_SHOWN + 2;
    for (let i = 1; i <= total; i++) {
      await backend().commands.addManualTime({
        taskId: task.id,
        minutes: i,
        note: "",
      });
    }
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);

    const section = await openFold(panel, fr.chrono.title);
    const journal = () => section.querySelectorAll("[data-segment]");
    expect(journal()).toHaveLength(SEGMENTS_SHOWN);
    await user.click(
      within(section).getByRole("button", {
        name: fr.folds.showAllSegments(total),
      }),
    );
    expect(journal()).toHaveLength(total);
  });

  it("says « Bloquée par » under the title and opens the relations", async () => {
    const task = await createTask("Livrer");
    const blocker = await createTask("Valider la maquette");
    await backend().commands.addRelation({
      taskId: task.id,
      otherId: blocker.id,
      kind: "blocked_by",
    });
    const user = userEvent.setup();
    render(<App />);
    const panel = await openPanel(task.id);

    const chip = await within(panel).findByRole("button", {
      name: fr.folds.blockedByChipLabel(1),
    });
    const relations = within(panel).getByRole("region", {
      name: fr.relations.title,
    });
    expect(relations).toHaveTextContent(fr.folds.blockedBy(1));
    expect(within(relations).queryByText("Valider la maquette")).toBeNull();

    await user.click(chip);
    await waitFor(() =>
      expect(
        within(relations).getByRole("button", { name: "Valider la maquette" }),
      ).toBeVisible(),
    );
  });
});
