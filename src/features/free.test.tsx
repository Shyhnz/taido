// Every feature is free: no Pro mark, no « Abonnement » tab, no redirect, no offers screen.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { useMenuStore } from "../components/Menu";
import { mockBackend } from "../lib/ipc";
import { resetUi, useUi } from "../stores/ui";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const project = (name: string) =>
  backend().commands.createSubject({
    name,
    color: null,
    rootPath: null,
    parentId: null,
  });

const task = (subjectId: string, title: string) =>
  backend().commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  useMenuStore.setState({ menu: null });
});

describe("no limits (mock, like the core)", () => {
  it("allows any number of projects, groups and links between projects", async () => {
    const ids: string[] = [];
    for (const name of ["A", "B", "C", "D", "E", "F"]) {
      ids.push((await project(name)).id);
    }
    const a1 = await task(ids[0], "a1");
    const b1 = await task(ids[1], "b1");
    await backend().commands.groupProjects({
      projectIds: [ids[0], ids[1]],
      groupId: null,
      name: null,
    });
    await backend().commands.addRelation({
      taskId: a1.id,
      otherId: b1.id,
      kind: "relates_to",
    });
  });
});

describe("no locks in the app", () => {
  it("« Nouveau projet » is enabled with 5 projects, and no « PRO » anywhere", async () => {
    for (const name of ["A", "B", "C", "D", "E"]) await project(name);
    render(<App />);
    const add = await screen.findByRole("button", { name: /Nouveau projet/ });
    expect(add).toBeEnabled();
    expect(add).not.toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Pro/i),
    );
    expect(screen.queryByText("PRO")).toBeNull();
  });

  it("Réglages has no « Abonnement » tab", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Réglages" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Réglages" }));
    const dialog = await screen.findByRole("dialog", { name: "Réglages" });
    const tabs = within(dialog)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(tabs).not.toContain("Abonnement");
    expect(screen.queryByText("PRO")).toBeNull();
  });

  it("the portfolio and the project dashboard open without a redirect", async () => {
    const a = await project("A");
    act(() => useUi.getState().setView({ kind: "portfolio", subjectId: null }));
    render(<App />);
    await screen.findByRole("main");
    await waitFor(() => expect(useUi.getState().view.kind).toBe("portfolio"));
    act(() => {
      useUi.getState().setView({ kind: "subject", subjectId: a.id });
      useUi.getState().setProjectTab("dashboard");
    });
    await waitFor(() => expect(useUi.getState().projectTab).toBe("dashboard"));
    expect(screen.queryByText("PRO")).toBeNull();
  });
});
