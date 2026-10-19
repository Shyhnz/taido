/**
 * Moving the notebook's pages from the list on the Mac (task 6): ⌥↑ / ⌥↓ move the focused
 * page within its group, never out of it, and « Épinglées » is not reordered. The drops
 * themselves are covered by `handleDragEnd` (src/features/dnd/DndProvider.test.ts).
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../App";
import { useMenuStore } from "../../components/Menu";
import { fr } from "../../i18n/fr";
import { mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

async function notebook() {
  const subject = await backend().commands.createSubject({
    name: "Taido",
    color: null,
    rootPath: null,
    parentId: null,
  });
  const decisions = await backend().commands.createNoteGroup({
    subjectId: subject.id,
    name: "Décisions",
  });
  const page = (title: string, groupId: string | null) =>
    backend().commands.createNotePage({
      subjectId: subject.id,
      groupId,
      title,
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
  const a = await page("A", decisions.id);
  await page("B", decisions.id);
  await page("C", decisions.id);
  const pin = await page("Serveur", null);
  await backend().commands.pinNotePage({ id: pin.id, pinned: true });
  await page("Épinglée 2", null).then((p) =>
    backend().commands.pinNotePage({ id: p.id, pinned: true }),
  );
  return { subjectId: subject.id, decisions, a };
}

async function openNotes(subjectId: string) {
  act(() => {
    useUi.getState().setView({ kind: "subject", subjectId });
    useUi.getState().setProjectTab("notes");
  });
  render(<App />);
  return screen.findByRole("navigation", { name: fr.notes.listLabel });
}

const titlesOf = (list: HTMLElement, block: string) =>
  Array.from(
    within(list)
      .getByRole("region", { name: block })
      .querySelectorAll("[data-note-title]"),
  ).map((t) => t.textContent);

const pageButton = (list: HTMLElement, title: string) =>
  within(list)
    .getByText(title)
    .closest("[data-note-page]")
    ?.querySelector("button") as HTMLElement;

beforeEach(() => {
  backend().reset({ seed: false });
  resetUi();
  useMenuStore.setState({ menu: null });
});

describe("moving pages with the keyboard", () => {
  it("⌥↓ / ⌥↑ move the page within its group and keep the focus on it", async () => {
    const { subjectId } = await notebook();
    const list = await openNotes(subjectId);
    await within(list).findByText("A");
    pageButton(list, "A").focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() =>
      expect(titlesOf(list, "Décisions")).toEqual(["B", "A", "C"]),
    );
    await waitFor(() => expect(pageButton(list, "A")).toHaveFocus());
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() =>
      expect(titlesOf(list, "Décisions")).toEqual(["B", "C", "A"]),
    );
    // The last page stays in its group.
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() =>
      expect(titlesOf(list, "Décisions")).toEqual(["B", "A", "C"]),
    );
  });

  it("« Épinglées » is not reordered", async () => {
    const { subjectId } = await notebook();
    const list = await openNotes(subjectId);
    await within(list).findByText("Serveur");
    pageButton(list, "Serveur").focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await new Promise((r) => setTimeout(r, 50));
    expect(titlesOf(list, fr.notes.pinned)).toEqual(["Serveur", "Épinglée 2"]);
  });

  it("⌥↓ does nothing during a search (the list is filtered)", async () => {
    const { subjectId } = await notebook();
    const list = await openNotes(subjectId);
    await userEvent.type(
      within(list).getByRole("searchbox", { name: fr.notes.search }),
      "A",
    );
    pageButton(list, "A").focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await new Promise((r) => setTimeout(r, 50));
    const nb = await backend().commands.notebook(subjectId);
    expect(nb.groups[0]?.pages.map((p) => p.title)).toEqual(["A", "B", "C"]);
  });

  it("an empty « Épinglées » stays, with a hint to drop a page there", async () => {
    const subject = await backend().commands.createSubject({
      name: "Vide",
      color: null,
      rootPath: null,
      parentId: null,
    });
    await backend().commands.createNotePage({
      subjectId: subject.id,
      groupId: null,
      title: "Seule",
      body: "",
      kind: "page",
      sourceTaskId: null,
    });
    const list = await openNotes(subject.id);
    const pinned = await within(list).findByRole("region", {
      name: fr.notes.pinned,
    });
    expect(pinned).toHaveTextContent(fr.notes.pinnedEmptyWide);
  });

  it("a right click still opens the page's menu", async () => {
    const { subjectId } = await notebook();
    const list = await openNotes(subjectId);
    const row = (await within(list).findByText("B")).closest(
      "[data-note-page]",
    ) as HTMLElement;
    await userEvent.pointer({ keys: "[MouseRight]", target: row });
    expect(useMenuStore.getState().menu?.label).toBe(fr.notes.pageMenu("B"));
  });
});
