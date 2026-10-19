import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";
import { handleShortcut } from "./useShortcuts";

/** Dispatches a keydown on `target` and runs the global handler like the window would. */
function press(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.addEventListener("keydown", (e) => handleShortcut(e), { once: true });
  target.dispatchEvent(event);
  return event;
}

function mount<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

describe("global shortcuts", () => {
  beforeEach(() => {
    mockBackend?.reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("⌘N opens the add dialog even from a text field (bug #10)", () => {
    const input = mount("input", { type: "text" });
    input.focus();
    const e = press(input, "n", { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(useUi.getState().dialog).toEqual({
      type: "addTask",
      target: { subjectId: null, sectionId: null, dueToday: true },
    });
  });

  it("never steals ⌘C, ⌘V, ⌘A, ⌘X or ⌘Z in a field", () => {
    const input = mount("input", { type: "text" });
    input.focus();
    for (const key of ["c", "v", "a", "x", "z"]) {
      expect(press(input, key, { metaKey: true }).defaultPrevented).toBe(false);
    }
    expect(useUi.getState().dialog).toBeNull();
  });

  it("⌘Enter checks the open task from a text field", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const task = await mockBackend.commands.createTask({
      title: "Relancer",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    useUi.setState({ openTaskId: task.id });
    const area = mount("textarea");
    area.focus();
    expect(press(area, "Enter", { metaKey: true }).defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(
        mockBackend?.state.tasks.find((t) => t.id === task.id)?.completedAt,
      ).not.toBeNull(),
    );
  });

  it("leaves ⌘Enter to a field that handles Enter, or to its form", () => {
    useUi.setState({ openTaskId: "t1" });
    const getTask = vi.spyOn(commands, "getTask");
    const input = mount("input", { type: "text" });
    input.addEventListener("keydown", (e) => e.preventDefault());
    input.focus();
    press(input, "Enter", { metaKey: true });
    const form = mount("form");
    const field = document.createElement("input");
    form.append(field);
    field.focus();
    expect(press(field, "Enter", { metaKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(getTask).not.toHaveBeenCalled();
    getTask.mockRestore();
  });

  it("⌘⇧N asks the sidebar for a new project", () => {
    const input = mount("input", { type: "text" });
    input.focus();
    press(input, "N", { metaKey: true, shiftKey: true });
    // Same store state as the sidebar « + Nouveau projet » line and the first-launch button.
    expect(useUi.getState()).toMatchObject({
      newProjectOpen: true,
      newProjectRequest: 1,
    });
    expect(useUi.getState().dialog).toBeNull();
  });

  it("⌘1 opens « À faire », also on an AZERTY keyboard", () => {
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    press(document.body, "&", { metaKey: true, code: "Digit1" });
    expect(useUi.getState().view).toEqual({ kind: "all", subjectId: null });

    useUi.getState().setView({ kind: "inbox", subjectId: null });
    const input = mount("input", { type: "text" });
    input.focus();
    press(input, "1", { metaKey: true });
    expect(useUi.getState().view.kind).toBe("all");
  });

  it("⌘2 opens Aujourd'hui, even on AZERTY", () => {
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    const e = press(document.body, "é", { metaKey: true, code: "Digit2" });
    expect(e.defaultPrevented).toBe(true);
    expect(useUi.getState().view).toEqual({ kind: "today", subjectId: null });
  });

  it("⌘3 opens « Prochainement », even on an AZERTY keyboard", () => {
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    const e = press(document.body, '"', { metaKey: true, code: "Digit3" });
    expect(e.defaultPrevented).toBe(true);
    expect(useUi.getState().view).toEqual({
      kind: "upcoming",
      subjectId: null,
    });
  });

  it("⌘4 and ⌘5 do nothing", () => {
    useUi.getState().setView({ kind: "inbox", subjectId: null });
    for (const d of ["4", "5"]) {
      const e = press(document.body, d, {
        metaKey: true,
        code: `Digit${d}`,
      });
      expect(e.defaultPrevented).toBe(false);
    }
    expect(useUi.getState().view.kind).toBe("inbox");
  });

  it("⌘, opens Réglages, even from a field", () => {
    const input = mount("input", { type: "text" });
    input.focus();
    const e = press(input, ",", { metaKey: true });
    expect(useUi.getState().dialog).toEqual({ type: "settings" });
    expect(e.defaultPrevented).toBe(true);
  });

  it("⌘K opens « Aller à une tâche », even from a field", () => {
    const input = mount("input", { type: "text" });
    input.focus();
    const e = press(input, "k", { metaKey: true });
    expect(useUi.getState().dialog).toEqual({ type: "search" });
    expect(e.defaultPrevented).toBe(true);
  });

  it("`q` only works when the list has the focus (bug #9)", () => {
    const navButton = mount("button");
    navButton.focus();
    press(navButton, "q");
    expect(useUi.getState().dialog).toBeNull();

    // Focus in the list.
    const row = mount("div", { tabindex: "0" });
    row.focus();
    useUi.getState().setListFocused(true);
    press(row, "q");
    expect(useUi.getState().dialog?.type).toBe("addTask");
  });

  it("j/k only move the selection when the list has the focus", () => {
    useUi.getState().setVisibleTasks([
      { id: "a", completed: false },
      { id: "b", completed: false },
    ]);
    const other = mount("button");
    other.focus();
    press(other, "j");
    expect(useUi.getState().selectedTaskId).toBeNull();

    other.blur(); // Focus nowhere: the list is the default target.
    press(document.body, "j");
    expect(useUi.getState().selectedTaskId).toBe("a");
    press(document.body, "j");
    expect(useUi.getState().selectedTaskId).toBe("b");
    press(document.body, "k");
    expect(useUi.getState().selectedTaskId).toBe("a");
  });

  it("`m` folds and shows the sidebar from the list, not from a field", () => {
    const input = mount("input", { type: "text" });
    input.focus();
    useUi.getState().setListFocused(true);
    expect(press(input, "m").defaultPrevented).toBe(false);
    expect(useUi.getState().sidebarOpen).toBe(true);
    input.blur();
    press(document.body, "m");
    expect(useUi.getState().sidebarOpen).toBe(false);
    press(document.body, "m");
    expect(useUi.getState().sidebarOpen).toBe(true);
  });

  it("`q` in a text field types a q", () => {
    const input = mount("input", { type: "text" });
    input.focus();
    useUi.getState().setListFocused(true);
    expect(press(input, "q").defaultPrevented).toBe(false);
    expect(useUi.getState().dialog).toBeNull();
  });

  it("⌘Enter checks an open task, then reopens it (bug #6)", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const task = await mockBackend.commands.createTask({
      title: "Relancer la DSI",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    // Panel open on the task, which the list does not show.
    useUi.setState({ openTaskId: task.id, selectedTaskId: null });

    press(document.body, "Enter", { metaKey: true });
    await waitFor(() =>
      expect(mockBackend?.state.tasks[0]?.completedAt).not.toBeNull(),
    );
    expect(useToasts.getState().toasts[0]?.message).toBe("Tâche terminée");

    press(document.body, "Enter", { metaKey: true });
    await waitFor(() =>
      expect(mockBackend?.state.tasks[0]?.completedAt).toBeNull(),
    );
    expect(useToasts.getState().toasts[0]?.message).toBe("Tâche rouverte");
    expect(useToasts.getState().toasts[0]?.action).toBeUndefined();
  });

  it("⌘Enter reopens a completed row selected in « Terminées »", async () => {
    if (!mockBackend) throw new Error("tests run with the mock backend");
    const task = await mockBackend.commands.createTask({
      title: "Envoyer le devis",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await mockBackend.commands.setTaskCompleted({
      id: task.id,
      completed: true,
    });
    // Even if the list's flag were stale, the core's completedAt decides.
    useUi.getState().setVisibleTasks([{ id: task.id, completed: false }]);
    useUi.getState().selectTask(task.id);

    press(document.body, "Enter", { metaKey: true });
    await waitFor(() =>
      expect(mockBackend?.state.tasks[0]?.completedAt).toBeNull(),
    );
    expect(useToasts.getState().toasts[0]?.message).toBe("Tâche rouverte");
  });

  it("does nothing while a dialog is open", () => {
    const dialog = { type: "moveTask", taskId: "t1" } as const;
    useUi.getState().openDialog(dialog);
    press(document.body, "n", { metaKey: true });
    expect(useUi.getState().dialog).toEqual(dialog);
  });
});
