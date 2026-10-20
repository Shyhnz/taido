import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../bindings";
import { commands, mockBackend } from "../lib/ipc";
import {
  currentLanguage,
  detectLanguage,
  LANGUAGE_KEY,
  reconcileLanguage,
  setLanguage,
} from "./index";

const navigatorLanguage = (value: string | undefined) =>
  vi
    .spyOn(window.navigator, "language", "get")
    .mockReturnValue(value as string);

describe("detectLanguage", () => {
  it("follows the system language, English by default", () => {
    expect(detectLanguage("fr-FR")).toBe("fr");
    expect(detectLanguage("fr")).toBe("fr");
    expect(detectLanguage("en-US")).toBe("en");
    expect(detectLanguage("de-DE")).toBe("en");
    expect(detectLanguage(undefined)).toBe("en");
  });
});

describe("currentLanguage", () => {
  beforeEach(() => window.localStorage.removeItem(LANGUAGE_KEY));
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
  });

  it("detects the language at first launch and stores it", () => {
    navigatorLanguage("fr-CA");
    expect(currentLanguage()).toBe("fr");
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("fr");
  });

  it("stored choice wins over navigator", () => {
    window.localStorage.setItem(LANGUAGE_KEY, "en");
    navigatorLanguage("fr-FR");
    expect(currentLanguage()).toBe("en");
  });

  it("ignores an unknown stored value", () => {
    window.localStorage.setItem(LANGUAGE_KEY, "klingon");
    navigatorLanguage("en-GB");
    expect(currentLanguage()).toBe("en");
  });
});

describe("setLanguage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
  });

  it('setLanguage("en") saves local + core and reloads', async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    await setLanguage("en");
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("en");
    expect((await commands.getSettings()).language).toBe("en");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("setLanguage ordering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
  });

  it("a failing core save keeps the old language and does not reload", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(commands, "updateSettings").mockRejectedValue({
      kind: "internal",
    });
    await setLanguage("en");
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("fr");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a reconcile while the save is pending cannot flip the choice", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    let release: (s: Settings) => void = () => {};
    const base = await commands.getSettings();
    vi.spyOn(commands, "updateSettings").mockReturnValue(
      new Promise<Settings>((r) => {
        release = r;
      }),
    );
    const pending = setLanguage("en");
    // A refetch now still shows the core's old language: it agrees with the local one.
    await reconcileLanguage({ ...base, language: "fr" });
    expect(reload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("fr");
    release({ ...base, language: "en" });
    await pending;
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("en");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileLanguage", () => {
  beforeEach(() => mockBackend?.reset({ seed: false }));
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
  });

  it("sends the local choice to the core when it has none", async () => {
    window.localStorage.setItem(LANGUAGE_KEY, "en");
    await reconcileLanguage(await commands.getSettings());
    expect((await commands.getSettings()).language).toBe("en");
  });

  it("adopts the core's language and reloads when they differ", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
    const settings = {
      ...(await commands.getSettings()),
      language: "en" as const,
    };
    await reconcileLanguage(settings);
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("en");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the choice cannot be stored", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const settings = {
      ...(await commands.getSettings()),
      language: "en" as const,
    };
    await reconcileLanguage(settings);
    setItem.mockRestore();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing when both agree", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const settings = {
      ...(await commands.getSettings()),
      language: "fr" as const,
    };
    await reconcileLanguage(settings);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("dates follow the language", () => {
  afterEach(() => {
    vi.resetModules();
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
  });

  it("dates use the English locale when language is en", async () => {
    window.localStorage.setItem(LANGUAGE_KEY, "en");
    vi.resetModules();
    const dates = await import("../lib/dates");
    const now = new Date(2026, 9, 1, 12);
    expect(dates.formatDue({ date: "2026-10-02", time: null }, now)).toBe(
      "Tomorrow",
    );
    expect(dates.formatDue({ date: "2026-10-05", time: null }, now)).toBe(
      "Monday",
    );
    expect(dates.formatShortDate(new Date(2026, 10, 3), now)).toBe("3 Nov");
  });

  it("and the French one when it is fr", async () => {
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
    vi.resetModules();
    const dates = await import("../lib/dates");
    const now = new Date(2026, 9, 1, 12);
    expect(dates.formatDue({ date: "2026-10-02", time: null }, now)).toBe(
      "Demain",
    );
    expect(dates.formatShortDate(new Date(2026, 10, 3), now)).toBe("3 nov.");
  });
});
