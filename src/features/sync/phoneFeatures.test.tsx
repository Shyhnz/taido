/**
 * The phone's feature set: Réglages keeps only « Général »
 * and the sync tab, and the sidebar shows no keyboard shortcut. The flags are mocked here; the
 * Mac set is covered by the other tests.
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import type { Features } from "../../lib/features";
import { mockBackend } from "../../lib/ipc";
import { resetUi, useUi } from "../../stores/ui";

const flags = vi.hoisted(
  (): Features => ({
    terminals: false,
    search: true,
    focusMode: false,
    states: false,
    folders: false,
    journal: false,
    dragAndDrop: false,
    touchDrag: true,
    shortcuts: false,
    tutorial: false,
    ask: false,
  }),
);
vi.mock("../../lib/features", () => ({ features: flags }));

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

describe("phone feature set", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });

  // The tab's name and content follow the build target (`IS_MOBILE`: « Synchro » and the login
  // form on the phone), which Vitest does not flip: here it is the Mac's « Compte ». The
  // phone's screen: src/mobile/SyncSettings.mobile.test.tsx.
  it("keeps only Général (language), Thème and the account tabs in Réglages", async () => {
    const user = userEvent.setup();
    render(<App />);
    const gear = await screen.findByRole("button", { name: "Réglages" });
    expect(gear).toHaveAttribute("title", "Réglages");
    await user.click(gear);
    const dialog = await screen.findByRole("dialog", { name: "Réglages" });
    expect(
      within(dialog)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Général", "Thème", "Compte"]);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(
      within(dialog).getByRole("tab", { name: "Compte", selected: true }),
    ).toHaveFocus();
    expect(
      await within(dialog).findByRole("button", { name: "Créer un compte" }),
    ).toBeInTheDocument();
  });

  it("opens the first tab when asked for a Mac-only tab", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Réglages" });
    act(() => {
      useUi.getState().openDialog({ type: "settings", tab: "agents" });
    });
    const dialog = await screen.findByRole("dialog", { name: "Réglages" });
    expect(
      within(dialog).getByRole("tab", { name: "Général", selected: true }),
    ).toBeInTheDocument();
  });

  it("shows no shortcut hint in the sidebar", async () => {
    render(<App />);
    const aside = await screen.findByRole("complementary");
    await within(aside).findByRole("button", { name: "Réglages" });
    expect(aside.querySelector("kbd")).toBeNull();
    expect(aside.textContent).not.toMatch(/⌘/);
    for (const el of aside.querySelectorAll("[title]")) {
      expect(el.getAttribute("title")).not.toMatch(/⌘/);
    }
  });
});
