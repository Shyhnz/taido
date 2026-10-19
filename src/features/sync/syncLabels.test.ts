import { describe, expect, it } from "vitest";
import type { SyncStatus } from "../../bindings";
import { syncButtonLabel, syncDetail } from "./syncLabels";

const NOW = new Date(2026, 9, 4, 14, 0, 0);
const status = (patch: Partial<SyncStatus>): SyncStatus => ({
  state: "idle",
  serverUrl: "https://sync.example.com",
  intervalMinutes: 5,
  lastSyncAt: new Date(NOW.getTime() - 8 * 60_000).toISOString(),
  errorKind: null,
  pending: 0,
  ...patch,
});

describe("sync labels", () => {
  it("tells the state and the last sync", () => {
    expect(syncButtonLabel(status({}), NOW)).toBe(
      "Synchroniser · À jour · Dernière synchro : il y a 8 min",
    );
    expect(syncButtonLabel(status({ lastSyncAt: null }), NOW)).toBe(
      "Synchroniser · À jour · Jamais synchronisé",
    );
    expect(syncButtonLabel(status({ state: "offline" }), NOW)).toBe(
      "Synchroniser · Hors connexion · Dernière synchro : il y a 8 min",
    );
  });

  it("adds the changes waiting to be sent only when up to date", () => {
    expect(syncDetail(status({ pending: 3 }), NOW)).toBe(
      "Dernière synchro : il y a 8 min · 3 modifications à envoyer",
    );
    expect(syncDetail(status({ state: "offline", pending: 3 }), NOW)).toBe(
      "Dernière synchro : il y a 8 min",
    );
  });

  it("shows the error text while in error", () => {
    expect(
      syncButtonLabel(
        status({ state: "error", errorKind: "deletions_held" }),
        NOW,
      ),
    ).toBe(
      "Synchroniser · Erreur de synchro · Beaucoup d'éléments ont disparu de ce téléphone : la synchro attend ta confirmation.",
    );
    expect(syncDetail(status({ state: "error", errorKind: null }), NOW)).toBe(
      "Un problème est survenu pendant la synchro.",
    );
  });

  it("has no detail when unlinked", () => {
    expect(syncButtonLabel(status({ state: "unlinked" }), NOW)).toBe(
      "Synchroniser · Synchro désactivée",
    );
  });
});
