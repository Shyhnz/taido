import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../../lib/ipc";
import { createFakeXterm, fakeTerms, resetFakeTerms } from "./fakeXterm";
import { handleDragDrop } from "./fileDrop";
import {
  focusTerminal,
  registeredTerminalIds,
  resetRegistry,
  setXtermFactory,
  showTerminal,
  syncTerminals,
} from "./registry";
import { backend, openRaw, taskWithFolder } from "./testSupport";

const parking = () =>
  document.querySelector<HTMLElement>("[data-terminal-parking]");

describe("terminal registry", () => {
  beforeEach(() => {
    backend().reset({ seed: false });
    resetFakeTerms();
    setXtermFactory(createFakeXterm);
  });
  afterEach(() => {
    resetRegistry();
    setXtermFactory(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates one instance per terminal, attaches it and replays the buffer", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "shell");
    // Output produced before the UI attaches is replayed.
    await commands.writeTerminal({ terminalId: info.id, data: "ls\r" });

    syncTerminals(await commands.listTerminals());
    expect(registeredTerminalIds()).toEqual([info.id]);
    expect(fakeTerms).toHaveLength(1);
    expect(fakeTerms[0].written).toContain("Shell (simulé)");
    expect(fakeTerms[0].written).toContain("(simulé) ls");
    // Parked off screen, out of the tab order, never display:none.
    const zone = parking();
    expect(zone).not.toBeNull();
    expect(zone?.hasAttribute("inert")).toBe(true);
    expect(zone?.style.display).not.toBe("none");
    expect(
      zone?.querySelector(`[data-terminal-id="${info.id}"]`),
    ).not.toBeNull();
  });

  it("is idempotent and streams typed text to the core", async () => {
    const task = await taskWithFolder();
    await openRaw(task.id, "shell");
    const list = await commands.listTerminals();
    syncTerminals(list);
    syncTerminals(list);
    expect(fakeTerms).toHaveLength(1);

    const spy = vi.spyOn(commands, "writeTerminal");
    fakeTerms[0].type("pwd");
    expect(spy).toHaveBeenCalledWith({ terminalId: list[0].id, data: "pwd" });
    // The echo comes back through the attached stream.
    expect(fakeTerms[0].written).toContain("pwd");
  });

  it("moves the container into a host and back, WebGL only while shown", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "agent");
    syncTerminals(await commands.listTerminals());
    const host = document.createElement("div");
    document.body.appendChild(host);

    const hide = showTerminal(info.id, host);
    expect(
      host.querySelector(`[data-terminal-id="${info.id}"]`),
    ).not.toBeNull();
    expect(fakeTerms[0].webgl).toBe(1);
    expect(fakeTerms[0].fits).toBeGreaterThan(0);
    // Showing twice in the same host (StrictMode) changes nothing.
    expect(showTerminal(info.id, host)).toBe(hide);

    hide();
    expect(host.children).toHaveLength(0);
    expect(
      parking()?.querySelector(`[data-terminal-id="${info.id}"]`),
    ).not.toBeNull();
    expect(fakeTerms[0].webgl).toBe(0);
    // Same instance, never re-created.
    expect(fakeTerms).toHaveLength(1);
    host.remove();
  });

  it("fills a host shown before the terminal reached the registry (review #2)", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "shell");
    const host = document.createElement("div");
    document.body.appendChild(host);
    // The panel lists the new terminal before the terminal list query does.
    const hide = showTerminal(info.id, host);
    expect(host.children).toHaveLength(0);
    syncTerminals(await commands.listTerminals());
    expect(
      host.querySelector(`[data-terminal-id="${info.id}"]`),
    ).not.toBeNull();
    hide();
    expect(host.children).toHaveLength(0);
    // A host hidden before the sync stays empty.
    const other = await openRaw(task.id, "shell");
    showTerminal(other.id, host)();
    syncTerminals(await commands.listTerminals());
    expect(host.children).toHaveLength(0);
    host.remove();
  });

  it("drops output that arrives after the instance was disposed", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "shell");
    syncTerminals(await commands.listTerminals());
    const before = fakeTerms[0].written;
    syncTerminals([]);
    await commands.writeTerminal({ terminalId: info.id, data: "late\r" });
    expect(fakeTerms[0].written).toBe(before);
  });

  it("disposes the instance when the core no longer keeps the terminal", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "shell");
    syncTerminals(await commands.listTerminals());
    await commands.closeTerminal(info.id);
    syncTerminals(await commands.listTerminals());
    expect(registeredTerminalIds()).toEqual([]);
    expect(fakeTerms[0].disposed).toBe(true);
    expect(
      document.querySelector(`[data-terminal-id="${info.id}"]`),
    ).toBeNull();
  });

  it("focuses a terminal as soon as it is shown", async () => {
    vi.useFakeTimers();
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "shell");
    focusTerminal(info.id);
    syncTerminals(await commands.listTerminals());
    const host = document.createElement("div");
    document.body.appendChild(host);
    showTerminal(info.id, host);
    await vi.advanceTimersByTimeAsync(1);
    expect(document.activeElement).toBe(fakeTerms[0].textarea);
    host.remove();
  });

  it("writes a newline on Shift+Enter and leaves ⌘ keys to the app", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "agent");
    syncTerminals(await commands.listTerminals());
    const spy = vi.spyOn(commands, "writeTerminal");
    const handler = fakeTerms[0].keyHandler;
    expect(handler).not.toBeNull();
    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
    });
    expect(handler?.(shiftEnter)).toBe(false);
    expect(spy).toHaveBeenCalledWith({ terminalId: info.id, data: "\n" });
    expect(
      handler?.(new KeyboardEvent("keydown", { key: "t", metaKey: true })),
    ).toBe(false);
    expect(handler?.(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
  });

  it("types the escaped paths of files dropped on the shown terminal", async () => {
    const task = await taskWithFolder();
    const info = await openRaw(task.id, "shell");
    syncTerminals(await commands.listTerminals());
    const host = document.createElement("section");
    host.dataset.terminalHost = info.id;
    document.body.appendChild(host);
    showTerminal(info.id, host);
    const spy = vi.spyOn(commands, "writeTerminal");
    const position = { x: 10, y: 10 } as never;

    handleDragDrop({ type: "enter", paths: ["/a b.png"], position });
    expect(host.hasAttribute("data-drop-target")).toBe(true);

    handleDragDrop({ type: "drop", paths: ["/a b.png", "/c.md"], position });
    expect(host.hasAttribute("data-drop-target")).toBe(false);
    expect(spy).toHaveBeenCalledWith({
      terminalId: info.id,
      data: "/a\\ b.png /c.md ",
    });
    host.remove();
  });
});
