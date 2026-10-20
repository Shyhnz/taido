import { describe, expect, it } from "vitest";
import { fr } from "./fr";

describe("second-line templates", () => {
  it("shows only the agent's state, never what it said or does", () => {
    expect(fr.line.waiting_permission(null, "claude")).toBe(
      "Claude attend ta réponse",
    );
    expect(fr.line.waiting_question(null, "claude")).toBe(
      "Claude attend ta réponse",
    );
    expect(fr.line.waiting_input(null, "claude")).toBe(
      "Claude attend ta réponse",
    );
    expect(fr.line.done(null, "claude")).toBe("Claude a fini");
    expect(fr.line.working(null, "claude")).toBe("Claude travaille");
    expect(fr.line.crashed()).toBe("Session arrêtée");
  });

  it("names Codex for a Codex session", () => {
    expect(fr.line.waiting_input(null, "codex")).toBe(
      "Codex attend ta réponse",
    );
    expect(fr.line.done(null, "codex")).toBe("Codex a fini");
    expect(fr.line.working(null, "codex")).toBe("Codex travaille");
    expect(fr.line.starting(null, "codex")).toBe("Démarrage de Codex…");
    expect(fr.ring.state("waiting", "codex")).toBe("Codex attend ta réponse");
    expect(fr.ring.state("human", "codex")).toBe("À faire");
    expect(fr.terminals.launchAgent("codex")).toBe("Lancer Codex");
    expect(fr.terminals.launchAgent("claude")).toBe("Lancer Claude Code");
  });
});

describe("what an account keeps (docs/SYNC.md, protocol 3)", () => {
  it("says the same on the Mac and on the phone", () => {
    expect(fr.account.privacy).toBe(fr.sync.privacy);
  });

  it("says the content of attachments is kept too", () => {
    expect(fr.account.privacy).toContain("noms et fichiers");
    expect(fr.account.privacy).not.toContain("pas leur contenu");
  });

  it("lists everything that is synced, and never the local-only data", () => {
    const [kept, never] = fr.account.privacy.split("Jamais ");
    for (const word of [
      "projets",
      "sections",
      "tâches",
      "colonnes du Kanban",
      "temps passé",
      "relations entre tâches",
      "pièces jointes (noms et fichiers)",
    ]) {
      expect(kept).toContain(word);
    }
    for (const word of [
      "dossiers",
      "terminaux",
      "sessions de Claude",
      "journal",
    ]) {
      expect(never).toContain(word);
    }
  });
});
