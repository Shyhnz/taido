/**
 * « Sans projet » among the top-level projects of the sidebar: rendered at its stored place, moved with ⌥↑ / ⌥↓ like a project, skipped by the
 * projects' ⌥↑ / ⌥↓ while hidden, never renamed nor deleted.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import type { Subject } from "../../bindings";
import { useToasts } from "../../components/Toast";
import { mockBackend } from "../../lib/ipc";
import { resetUi } from "../../stores/ui";
import { useProjectRename } from "./subjectActions";
import { topLevelIndex, topLevelItems } from "./topLevel";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const nav = () => screen.getByRole("navigation", { name: "Navigation" });

const project = (name: string, parentId: string | null = null) =>
  backend().commands.createSubject({
    name,
    color: "violet",
    rootPath: null,
    parentId,
  });

const task = (title: string, subjectId: string | null) =>
  backend().commands.createTask({
    title,
    description: null,
    subjectId,
    sectionId: null,
    dueDate: null,
    dueTime: null,
  });

/** Sidebar top-level rows in display order (projects and « Sans projet »). */
const rows = () =>
  within(nav())
    .getAllByRole("button", { name: /^(Globex|Perso|Vide|Sans projet)/ })
    .map((b) => (b.textContent ?? "").replace(/\d+$/, ""));

/** The top-level order from the backend, `*` for « Sans projet ». */
async function order() {
  const top = (await backend().commands.listSubjects())
    .filter((s) => s.parentId === null)
    .map((s) => s.name);
  top.splice(await backend().commands.getInboxIndex(), 0, "*");
  return top;
}

const inboxButton = () =>
  within(nav()).getByRole("button", { name: /^Sans projet/ });

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  useProjectRename.setState({ renamingId: null });
  useToasts.setState({ toasts: [] });
});

describe("topLevelItems", () => {
  const s = (id: string) => ({ id }) as Subject;
  const kinds = (inboxIndex: number) =>
    topLevelItems([s("a"), s("b")], inboxIndex).map((i) =>
      i.kind === "inbox" ? "*" : i.subject.id,
    );

  it("inserts « Sans projet » at its index, clamped", () => {
    expect(kinds(0)).toEqual(["*", "a", "b"]);
    expect(kinds(1)).toEqual(["a", "*", "b"]);
    expect(kinds(2)).toEqual(["a", "b", "*"]);
    expect(kinds(9)).toEqual(["a", "b", "*"]);
    expect(kinds(-1)).toEqual(["*", "a", "b"]);
  });

  it("counts « Sans projet » in a project's index", () => {
    expect(topLevelIndex(0, 1)).toBe(0);
    expect(topLevelIndex(1, 1)).toBe(2);
  });
});

describe("« Sans projet » in the sidebar", () => {
  it("sits among the top-level projects at its place", async () => {
    const globex = await project("Globex");
    await project("Perso");
    await task("Raycast", null);
    await task("Facture", globex.id);
    render(<App />);
    await within(nav()).findByRole("button", { name: /^Sans projet/ });
    // Never placed: last, after every project (today's behaviour).
    expect(rows()).toEqual(["Globex", "Perso", "Sans projet"]);
    await backend().commands.reorderInbox(1);
    await waitFor(() =>
      expect(rows()).toEqual(["Globex", "Sans projet", "Perso"]),
    );
    // Its open-task count is kept.
    expect(inboxButton()).toHaveTextContent("Sans projet1");
  });

  it("moves with ⌥↑ / ⌥↓, keeping the focus on its row", async () => {
    await project("Globex");
    await project("Perso");
    await task("Raycast", null);
    const user = userEvent.setup();
    render(<App />);
    (
      await within(nav()).findByRole("button", { name: /^Sans projet/ })
    ).focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(async () =>
      expect(await order()).toEqual(["Globex", "*", "Perso"]),
    );
    await waitFor(() =>
      expect(rows()).toEqual(["Globex", "Sans projet", "Perso"]),
    );
    await waitFor(() => expect(inboxButton()).toHaveFocus());
    expect(
      await screen.findByText("« Sans projet » monté d'un cran"),
    ).toBeInTheDocument();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(async () =>
      expect(await order()).toEqual(["*", "Globex", "Perso"]),
    );
    await waitFor(() =>
      expect(rows()).toEqual(["Sans projet", "Globex", "Perso"]),
    );
    // Already first: nothing moves.
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect(inboxButton()).toHaveFocus());
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(async () =>
      expect(await order()).toEqual(["Globex", "*", "Perso"]),
    );
  });

  it("lets a project jump over its hidden slot with ⌥↑ / ⌥↓", async () => {
    await project("Globex");
    await project("Perso");
    await backend().commands.reorderInbox(1);
    const user = userEvent.setup();
    render(<App />);
    const globex = await within(nav()).findByRole("button", {
      name: /^Globex/,
    });
    // No task without project: the row is hidden (D2), its slot still counts.
    expect(
      within(nav()).queryByRole("button", { name: /^Sans projet/ }),
    ).toBeNull();
    globex.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(async () =>
      expect(await order()).toEqual(["*", "Perso", "Globex"]),
    );
    await waitFor(() => expect(rows()).toEqual(["Perso", "Globex"]));
  });

  it("does not move the last visible project onto its hidden slot", async () => {
    await project("Perso");
    await project("Globex");
    const user = userEvent.setup();
    render(<App />);
    // Never placed: hidden and last. ⌥↓ on the last project does nothing.
    const globex = await within(nav()).findByRole("button", {
      name: /^Globex/,
    });
    globex.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(async () =>
      expect(await order()).toEqual(["Globex", "Perso", "*"]),
    );
    await waitFor(() => expect(rows()).toEqual(["Globex", "Perso"]));
  });

  it("has no menu: never renamed nor deleted", async () => {
    await project("Globex");
    await task("Raycast", null);
    render(<App />);
    const inbox = await within(nav()).findByRole("button", {
      name: /^Sans projet/,
    });
    expect(
      within(nav()).queryByRole("button", {
        name: /Actions du projet Sans projet/,
      }),
    ).toBeNull();
    fireEvent.contextMenu(inbox);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(nav()).queryByRole("textbox")).toBeNull();
  });
});
