import { describe, expect, it } from "vitest";
import { en, enHelpers } from "../i18n/en";
import { fr, frHelpers } from "../i18n/fr";
import { detectOs, forPlatform, keysFor, textFor } from "./platform";

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("detectOs", () => {
  it("knows Windows from its WebView, and keeps the Mac look elsewhere", () => {
    expect(detectOs(WINDOWS_UA)).toBe("windows");
    expect(detectOs(MAC_UA)).toBe("mac");
    expect(detectOs(undefined)).toBe("mac");
  });
});

describe("reveal_label_follows_os", () => {
  it("says Finder on macOS and Explorer on Windows, in both languages", () => {
    expect(forPlatform(en, "mac", "en").attachments.reveal).toBe(
      "Show in Finder",
    );
    expect(forPlatform(en, "windows", "en").attachments.reveal).toBe(
      "Show in Explorer",
    );
    expect(forPlatform(en, "windows", "en").terminals.openInFinder).toBe(
      "Open in Explorer",
    );
    expect(forPlatform(en, "windows", "en").terminals.finder).toBe("Explorer");
    expect(forPlatform(fr, "mac", "fr").attachments.reveal).toBe(
      "Afficher dans le Finder",
    );
    expect(forPlatform(fr, "windows", "fr").attachments.reveal).toBe(
      "Afficher dans l'Explorateur",
    );
    expect(forPlatform(fr, "windows", "fr").terminals.openInFinder).toBe(
      "Ouvrir dans l'Explorateur",
    );
    expect(forPlatform(fr, "windows", "fr").terminals.finder).toBe(
      "Explorateur",
    );
    expect(textFor("glisse un fichier du Finder", "windows", "fr")).toBe(
      "glisse un fichier de l'Explorateur",
    );
    expect(textFor("drag a file from Finder", "windows", "en")).toBe(
      "drag a file from Explorer",
    );
  });

  it("follows the OS in functions of the tables too", () => {
    const winHelpers = forPlatform(frHelpers, "windows", "fr");
    expect(winHelpers.agentInstallCommand("claude")).toBe(
      frHelpers.agentInstallCommand("claude"),
    );
    const t = forPlatform(en, "windows", "en");
    for (const text of Object.values(t.terminals)) {
      if (typeof text === "string") expect(text).not.toContain("Finder");
    }
    expect(forPlatform(enHelpers, "mac", "en")).toBe(enHelpers);
  });
});

describe("shortcut_label_follows_os", () => {
  it("shows ⌘ on macOS and Ctrl on Windows", () => {
    expect(keysFor("⌘⇧N", "mac")).toBe("⌘⇧N");
    expect(keysFor("⌘⇧N", "windows")).toBe("Ctrl+Shift+N");
    expect(keysFor("⌘K", "windows")).toBe("Ctrl+K");
    expect(keysFor("⌘,", "windows")).toBe("Ctrl+,");
    expect(keysFor("⌘1 · ⌘2 · ⌘3", "windows")).toBe("Ctrl+1 · Ctrl+2 · Ctrl+3");
    expect(keysFor("⌥Enter", "windows")).toBe("Alt+Enter");
    expect(forPlatform(en, "windows", "en").search.open).toBe(
      "Search (Ctrl+K)",
    );
    expect(forPlatform(fr, "windows", "fr").settings.open).toBe(
      "Réglages (Ctrl+,)",
    );
    expect(forPlatform(en, "mac", "en").search.open).toBe("Search (⌘K)");
  });

  it("gives a Windows example path for the agent setting", () => {
    expect(
      textFor(
        "Enter an absolute path, for example /opt/homebrew/bin/claude.",
        "windows",
        "en",
      ),
    ).toBe(
      "Enter an absolute path, for example C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd.",
    );
  });
});
