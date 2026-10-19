/**
 * Sidebar navigation and bug B1: the highlight must sit on exactly one item, the
 * one shown in the main area, whether we navigate by click or with ⌘1.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { mockBackend } from "../../lib/ipc";
import { resetUi } from "../../stores/ui";
import { isActiveView, navRowClass } from "./Sidebar";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function seedProjects() {
  const b = backend();
  await b.commands.createSubject({
    name: "Globex",
    color: "violet",
    rootPath: "/tmp/globex",
    parentId: null,
  });
  await b.commands.createSubject({
    name: "Perso",
    color: "teal",
    rootPath: "/tmp/perso",
    parentId: null,
  });
}

/** Names of the navigation items marked as the current page. */
function currentItems(): string[] {
  const nav = screen.getByRole("navigation", { name: "Navigation" });
  return within(nav)
    .queryAllByRole("button")
    .filter((b) => b.getAttribute("aria-current") === "page")
    .map((b) => b.textContent ?? "");
}

/** Rows rendered as active (accent bar + background). */
function activeRows(): Element[] {
  return Array.from(document.querySelectorAll(".nav-row-active"));
}

describe("Sidebar navigation", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });

  it("reorders projects with ⌥↑ / ⌥↓, keeping the focus on the row", async () => {
    await seedProjects();
    const user = userEvent.setup();
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Navigation" });
    const perso = await within(nav).findByRole("button", { name: /^Perso/ });
    perso.focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() =>
      expect(
        backend()
          .state.subjects.slice()
          .sort((a, b) => a.position - b.position)
          .map((s) => s.name),
      ).toEqual(["Perso", "Globex"]),
    );
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole("button", { name: /^(Globex|Perso)/ })
          .map((b) => b.textContent),
      ).toEqual(["Perso", "Globex"]),
    );
    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: /^Perso/ })).toHaveFocus(),
    );
    // Already first: nothing moves.
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() =>
      expect(
        backend()
          .state.subjects.slice()
          .sort((a, b) => a.position - b.position)
          .map((s) => s.name),
      ).toEqual(["Globex", "Perso"]),
    );
  });

  it("shows Aujourd'hui and Prochainement as transverse views", async () => {
    await seedProjects();
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Navigation" });
    expect(
      await within(nav).findByRole("button", { name: /^Globex/ }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", { name: /Aujourd'hui/ }),
    ).toBeInTheDocument();
    // « À faire » first (⌘1), then « Aujourd'hui » (⌘2), then « Prochainement »
    // (⌘3).
    const navNames = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    const today = navNames.findIndex((n) => n.startsWith("Aujourd'hui"));
    // The visible text ends with its shortcut, like « Recherche ⌘K ».
    expect(navNames[today - 1]).toBe("À faire⌘1");
    expect(navNames[today + 1]).toBe("Prochainement⌘3");
    expect(
      within(nav).getByRole("button", { name: "Prochainement" }),
    ).toHaveAttribute("title", "Prochainement (⌘3)");
    for (const gone of [
      /Boîte de réception/,
      /À toi de jouer/,
      /Sessions/,
      /Sans projet/,
    ]) {
      expect(within(nav).queryByRole("button", { name: gone })).toBeNull();
    }
    // No unfinished UI: no Claude footer, no « Bientôt ».
    // « Recherche » is a row (magnifier + label) that opens ⌘K; the header
    // magnifier is gone.
    expect(
      screen.getByRole("button", { name: "Recherche" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rechercher" })).toBeNull();
    expect(screen.queryByText(/Claude Code/)).toBeNull();
    expect(screen.queryByText(/Bientôt|Jalon/)).toBeNull();
  });

  it("opens ⌘K from the « Recherche » row (magnifier + label)", async () => {
    const user = userEvent.setup();
    await seedProjects();
    render(<App />);
    const row = await screen.findByRole("button", { name: "Recherche" });
    expect(row.querySelector("svg")).not.toBeNull();
    expect(row).toHaveTextContent("Recherche⌘K");
    expect(row).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(row);
    expect(
      await screen.findByRole("dialog", { name: "Rechercher" }),
    ).toBeInTheDocument();
  });

  it("highlights « Prochainement » when its view shows", async () => {
    const user = userEvent.setup();
    await seedProjects();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Prochainement" }),
    );
    expect(currentItems()).toEqual(["Prochainement⌘3"]);
  });

  it("shows « Sans projet » only when a task has no project", async () => {
    const b = backend();
    const task = await b.commands.createTask({
      title: "Idée en vrac",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    render(<App />);
    const line = await screen.findByRole("button", { name: /Sans projet/ });
    expect(line).toHaveTextContent("1");

    await b.commands.deleteTask(task.id);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Sans projet/ })).toBeNull(),
    );
  });

  it("keeps « Sans projet » and its view when its only task is completed", async () => {
    const b = backend();
    const task = await b.commands.createTask({
      title: "Idée en vrac",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    render(<App />);
    await screen.findByRole("button", { name: /Sans projet/ });
    await b.commands.setTaskCompleted({ id: task.id, completed: true });
    // Give the refetches a chance to land, then check nothing switched.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sans projet/ }),
      ).not.toHaveTextContent("1"),
    );
    expect(
      screen.getByRole("button", { name: /Sans projet/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Commence par un projet")).toBeNull();
  });

  it("moves the highlight by click and with ⌘2, never leaving it on the previous item", async () => {
    await seedProjects();
    const user = userEvent.setup();
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Navigation" });
    const today = within(nav).getByRole("button", { name: /Aujourd'hui/ });
    const globex = await within(nav).findByRole("button", { name: /^Globex/ });
    const perso = within(nav).getByRole("button", { name: /^Perso/ });

    expect(currentItems()).toEqual([today.textContent]);
    expect(activeRows()).toHaveLength(1);

    await user.click(globex);
    expect(currentItems()).toEqual([globex.textContent]);
    expect(activeRows()).toHaveLength(1);
    expect(globex.closest(".nav-row")).toHaveClass("nav-row-active");
    expect(today).not.toHaveClass("nav-row-active");

    await user.click(perso);
    expect(currentItems()).toEqual([perso.textContent]);
    expect(globex.closest(".nav-row")).not.toHaveClass("nav-row-active");

    // ⌘2 goes back to Today and releases the focus of the clicked item, which would
    // otherwise show its :focus-visible ring after a keyboard shortcut.
    expect(document.activeElement).toBe(perso);
    await user.keyboard("{Meta>}2{/Meta}");
    expect(currentItems()).toEqual([today.textContent]);
    expect(activeRows()).toHaveLength(1);
    expect(today).toHaveClass("nav-row-active");
    expect(document.activeElement).not.toBe(perso);
    expect(
      await within(screen.getByRole("main")).findByRole("heading", {
        level: 1,
        name: "Aujourd'hui",
      }),
    ).toBeInTheDocument();
  });

  it("never animates the active state", () => {
    expect(navRowClass(true)).not.toMatch(/transition/);
    expect(navRowClass(false)).not.toMatch(/transition/);
    expect(navRowClass(true)).toContain("nav-row-active");
    expect(navRowClass(true)).toContain("font-medium");
  });

  it("matches a project view by its id", () => {
    const view = { kind: "subject" as const, subjectId: "a" };
    expect(isActiveView(view, { kind: "subject", subjectId: "a" })).toBe(true);
    expect(isActiveView(view, { kind: "subject", subjectId: "b" })).toBe(false);
    expect(isActiveView(view, { kind: "today", subjectId: null })).toBe(false);
  });
});
