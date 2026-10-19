/**
 * Review point 2: in the web app, which shares its origin and
 * its token with the API, a joined HTML or SVG never runs: every file is saved (« Télécharger »,
 * 2026-10-10: images too), never shown nor navigated to.
 */

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardStrayDrops, REVOKE_AFTER_MS, saveBlob } from "./web-files";

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(
    parts.flatMap((p) =>
      typeof p === "string" ? [...new TextEncoder().encode(p)] : p,
    ),
  );

const HTML = bytes(
  "<!doctype html><script>fetch('/api/sync',{headers:{}})</script>",
);

describe("saveBlob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("saves through a temporary <a download> of an octet-stream blob, revoked soon after", async () => {
    vi.useFakeTimers();
    const made: Blob[] = [];
    const created = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      made.push(b as Blob);
      return `blob:http://localhost/${made.length}`;
    });
    const revoked = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clicks: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({
        href: this.href,
        download: this.download,
        attached: this.isConnected,
      });
    });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const before = window.location.href;

    saveBlob(new Blob([HTML as BlobPart], { type: "text/html" }), "page.html");

    expect(created).toHaveBeenCalledTimes(1);
    expect(made[0].type).toBe("application/octet-stream");
    expect(new Uint8Array(await made[0].arrayBuffer())).toEqual(HTML);
    expect(clicks).toEqual([
      {
        href: "blob:http://localhost/1",
        download: "page.html",
        attached: true,
      },
    ]);
    // Nothing left in the page, nothing opened, the app never navigated.
    expect(document.querySelector("a[download]")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(revoked).not.toHaveBeenCalled();
    // Minutes, not seconds: iOS Safari asks « Télécharger ? » first and reads the URL after.
    expect(REVOKE_AFTER_MS).toBeGreaterThanOrEqual(5 * 60_000);
    vi.advanceTimersByTime(REVOKE_AFTER_MS - 1);
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoked).toHaveBeenCalledWith("blob:http://localhost/1");
  });
});

describe("guardStrayDrops", () => {
  it("a file dropped beside the drop zones never makes the app navigate away", () => {
    const stop = guardStrayDrops(window);
    try {
      const outside = document.createElement("p");
      const zone = document.createElement("div");
      zone.setAttribute("data-drop-zone", "");
      const inner = document.createElement("span");
      zone.append(inner);
      document.body.append(outside, zone);
      const files = () => ({ types: ["Files"], dropEffect: "copy" });

      const overOutside = files();
      expect(fireEvent.dragOver(outside, { dataTransfer: overOutside })).toBe(
        false,
      );
      expect(overOutside.dropEffect).toBe("none");
      expect(fireEvent.drop(outside, { dataTransfer: files() })).toBe(false);
      // Inside a zone, the zone decides (its own handlers accept the files).
      const overZone = files();
      fireEvent.dragOver(inner, { dataTransfer: overZone });
      expect(overZone.dropEffect).toBe("copy");
      // Not files (text dragged around the page): left alone.
      expect(
        fireEvent.drop(outside, { dataTransfer: { types: ["text/plain"] } }),
      ).toBe(true);
      outside.remove();
      zone.remove();
    } finally {
      stop();
    }
    const after = document.createElement("p");
    document.body.append(after);
    expect(fireEvent.drop(after, { dataTransfer: { types: ["Files"] } })).toBe(
      true,
    );
    after.remove();
  });
});
