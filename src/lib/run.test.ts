import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../components/Toast";
import { commands, openFolder } from "./ipc";
import { readableError, run } from "./run";

describe("core errors in the UI (bug #12)", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("translates each kind into French", () => {
    expect(readableError({ kind: "not_found", message: "task x" })).toBe(
      "Cet élément n'existe plus.",
    );
    expect(readableError({ kind: "invalid", message: "empty title" })).toBe(
      "Cette valeur n'est pas valide.",
    );
    expect(readableError({ kind: "internal", message: "db locked" })).toBe(
      "Un problème est survenu. Réessaie.",
    );
    expect(readableError(new Error("boom"))).toBe(
      "Un problème est survenu. Réessaie.",
    );
    expect(
      readableError(
        { kind: "invalid", message: "empty title" },
        "Impossible d'ajouter la tâche.",
      ),
    ).toBe("Impossible d'ajouter la tâche. Vérifie la saisie.");
  });

  it("shows a persistent French toast and logs the raw detail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(
      Promise.reject({ kind: "internal", message: "database is locked" }),
      "Impossible d'ajouter la tâche.",
    );
    expect(result).toBeUndefined();
    const [toast] = useToasts.getState().toasts;
    expect(toast?.message).toBe("Impossible d'ajouter la tâche. Réessaie.");
    expect(toast?.tone).toBe("error");
    expect(toast?.message).not.toContain("database");
    expect(log).toHaveBeenCalledWith("database is locked", expect.anything());
  });
});

describe("openFolder (bug #11)", () => {
  it("opens the folder itself with open_path", async () => {
    const spy = vi.spyOn(commands, "openPath");
    await openFolder("/Users/user/clients/acme");
    expect(spy).toHaveBeenCalledWith({
      path: "/Users/user/clients/acme",
      with: "finder",
      editor: null,
    });
  });
});
