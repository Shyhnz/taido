import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";

describe("Échéance… dialog", () => {
  beforeEach(() => {
    mockBackend?.reset({ seed: false });
    resetUi();
  });

  it("uses the French date picker instead of native inputs", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const task = await mockBackend.commands.createTask({
      title: "Relancer",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const user = userEvent.setup();
    render(<App />);
    act(() =>
      useUi.getState().openDialog({ type: "due", taskId: task.id, due: null }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Échéance" });
    expect(dialog.querySelector('input[type="date"]')).toBeNull();
    expect(dialog.querySelector('input[type="time"]')).toBeNull();
    // The first quick option has the focus.
    const today = within(dialog).getByRole("button", { name: /^Aujourd'hui/ });
    expect(today).toHaveFocus();
    await user.click(today);
    await waitFor(() =>
      expect(
        mockBackend?.state.tasks.find((t) => t.id === task.id)?.dueDate,
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("dialog", { name: "Échéance" })).toBeNull();
  });
});

describe("Déplacer vers… dialog", () => {
  beforeEach(() => {
    mockBackend?.reset({ seed: false });
    resetUi();
  });

  it("is titled « Ranger dans… » for a task of Sans projet and uses colored dots", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const subject = await mockBackend.commands.createSubject({
      name: "Site",
      color: null,
      rootPath: null,
      parentId: null,
    });
    const section = await mockBackend.commands.createSection({
      subjectId: subject.id,
      name: "Design",
      subpath: null,
    });
    const task = await mockBackend.commands.createTask({
      title: "Relancer",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const user = userEvent.setup();
    render(<App />);
    act(() =>
      useUi
        .getState()
        .openDialog({ type: "moveTask", taskId: task.id, file: true }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Ranger dans…" });
    expect(within(dialog).queryByText("#")).toBeNull();
    await user.click(
      await within(dialog).findByRole("button", { name: "Design" }),
    );
    expect(
      await screen.findByText("Déplacée dans Site › Design"),
    ).toBeInTheDocument();
    expect(
      mockBackend.state.tasks.find((t) => t.id === task.id)?.sectionId,
    ).toBe(section.id);
  });

  it("is titled « Déplacer vers… » otherwise", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const task = await mockBackend.commands.createTask({
      title: "Relancer",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    render(<App />);
    act(() =>
      useUi.getState().openDialog({ type: "moveTask", taskId: task.id }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Déplacer vers…" }),
    ).toBeInTheDocument();
  });

  it("names a group's project with its group, so two « Admin » stay distinct", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const backend = mockBackend;
    const c = backend.commands;
    const project = (name: string, parentId: string | null) => {
      // Taido V2.2 bis: only a group holds projects.
      const parent = backend.state.subjects.find((s) => s.id === parentId);
      if (parent) parent.isGroup = true;
      return c.createSubject({ name, color: null, rootPath: null, parentId });
    };
    const globex = await project("Globex", null);
    await project("Admin", globex.id);
    const perso = await project("Perso", null);
    const persoAdmin = await project("Admin", perso.id);
    const task = await c.createTask({
      title: "Relancer",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    const user = userEvent.setup();
    render(<App />);
    act(() =>
      useUi.getState().openDialog({ type: "moveTask", taskId: task.id }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Déplacer vers…",
    });
    expect(
      await within(dialog).findByRole("button", { name: "Globex › Admin" }),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Perso › Admin" }),
    );
    expect(
      await screen.findByText("Déplacée dans Perso › Admin"),
    ).toBeInTheDocument();
    expect(
      mockBackend.state.tasks.find((t) => t.id === task.id)?.subjectId,
    ).toBe(persoAdmin.id);
  });
});
