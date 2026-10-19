/**
 * « Synchroniser » button: hidden until linked, its states,
 * tooltip and accessible name, the click, and the phone's top bar variant.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useToasts } from "../../components/Toast";
import { commands, mockBackend } from "../../lib/ipc";
import { createQueryClient } from "../../lib/queries";
import { resetUi } from "../../stores/ui";
import { SyncButton } from "./index";

function backend() {
  if (!mockBackend) throw new Error("tests run with the mock backend");
  return mockBackend;
}

const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();

const LINKED = {
  state: "idle" as const,
  serverUrl: "https://sync.example.com",
  lastSyncAt: minutesAgo(8),
  errorKind: null,
  pending: 0,
};

function syncButton(): HTMLElement {
  const aside = screen.getByRole("complementary");
  return within(aside).getByRole("button", { name: /^Synchroniser/ });
}

describe("sync button", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetUi();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("is hidden until an account is linked, then sits left of Réglages", async () => {
    render(<App />);
    const settings = await screen.findByRole("button", { name: "Réglages" });
    expect(screen.queryByRole("button", { name: /^Synchroniser/ })).toBeNull();

    act(() => {
      backend().sync.set(LINKED);
    });
    const button = await screen.findByRole("button", {
      name: "Synchroniser · À jour · Dernière synchro : il y a 8 min",
    });
    expect(button).toHaveAttribute(
      "title",
      "Synchroniser · À jour · Dernière synchro : il y a 8 min",
    );
    expect(button.nextElementSibling).toBe(settings);
    expect(button).toHaveStyle({ width: "28px", height: "28px" });

    act(() => {
      backend().sync.set({ state: "unlinked" });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Synchroniser/ }),
      ).toBeNull(),
    );
  });

  it("shows each state: syncing, offline, error, pending", async () => {
    backend().sync.set(LINKED);
    render(<App />);
    await screen.findByRole("button", { name: /^Synchroniser · À jour/ });

    act(() => {
      backend().sync.set({ state: "syncing" });
    });
    await waitFor(() =>
      expect(syncButton()).toHaveAttribute("data-sync-state", "syncing"),
    );
    expect(syncButton()).toHaveAttribute("aria-busy", "true");
    expect(syncButton().querySelector("svg")).toHaveClass(
      "motion-safe:animate-spin",
    );

    act(() => {
      backend().sync.set({ state: "offline" });
    });
    await waitFor(() =>
      expect(syncButton()).toHaveAccessibleName(
        "Synchroniser · Hors connexion · Dernière synchro : il y a 8 min",
      ),
    );
    expect(syncButton().querySelector(".lucide-cloud-off")).not.toBeNull();

    act(() => {
      backend().sync.set({ state: "error", errorKind: "deletions_held" });
    });
    await waitFor(() =>
      expect(syncButton()).toHaveAccessibleName(
        "Synchroniser · Erreur de synchro · Beaucoup d'éléments ont disparu de ce téléphone : la synchro attend ta confirmation.",
      ),
    );
    expect(syncButton().querySelector("[data-sync-error]")).toHaveClass(
      "text-waiting-text",
    );

    act(() => {
      backend().sync.set({ state: "error", errorKind: "unauthorized" });
    });
    await waitFor(() =>
      expect(syncButton()).toHaveAccessibleName(
        "Synchroniser · Erreur de synchro · Connexion refusée : reconnecte-toi dans les Réglages.",
      ),
    );

    act(() => {
      backend().sync.set({ state: "idle", errorKind: null, pending: 2 });
    });
    await waitFor(() =>
      expect(syncButton()).toHaveAccessibleName(
        "Synchroniser · À jour · Dernière synchro : il y a 8 min · 2 modifications à envoyer",
      ),
    );
  });

  it("syncs now on click", async () => {
    backend().sync.set({ ...LINKED, lastSyncAt: null });
    const spy = vi.spyOn(commands, "syncNow");
    const user = userEvent.setup();
    render(<App />);
    const button = await screen.findByRole("button", {
      name: "Synchroniser · À jour · Jamais synchronisé",
    });
    await user.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(syncButton()).toHaveAccessibleName(
        "Synchroniser · À jour · Dernière synchro : à l'instant",
      ),
    );
  });

  it("has a 44 px target in the phone's top bar", async () => {
    backend().sync.set(LINKED);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SyncButton variant="topbar" />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole("button", {
      name: /^Synchroniser · À jour/,
    });
    expect(button).toHaveStyle({ width: "44px", height: "44px" });
  });
});
