/** The page's half of the same-build activation (src/mobile/swUpdate.ts). */

import { describe, expect, it, vi } from "vitest";
import { activateIfSameBuild, applyUpdateWith } from "./swUpdate";

/** A worker answering like mobile/sw.js with this pre-cache, or never (an older one). */
function worker(precache: string[] | null) {
  const sent: unknown[] = [];
  return {
    sent,
    postMessage(message: unknown, transfer: Transferable[]) {
      sent.push(message);
      const port = transfer[0] as MessagePort;
      const { type, path } = message as { type: string; path: string };
      if (precache === null || type !== "SKIP_WAITING_IF_SAME_BUILD") return;
      port.postMessage({ skipping: precache.includes(path) });
    },
  } as Pick<ServiceWorker, "postMessage"> & { sent: unknown[] };
}

describe("activateIfSameBuild", () => {
  it("sends this page's script path and reads the worker's answer", async () => {
    const same = worker(["/assets/swUpdate-abc.js"]);
    expect(await activateIfSameBuild(same, "/assets/swUpdate-abc.js")).toBe(
      true,
    );
    expect(same.sent).toEqual([
      { type: "SKIP_WAITING_IF_SAME_BUILD", path: "/assets/swUpdate-abc.js" },
    ]);
    expect(
      await activateIfSameBuild(worker(["/assets/x.js"]), "/assets/y.js"),
    ).toBe(false);
  });

  it("an older worker that never answers leaves the choice to « Recharger »", async () => {
    expect(await activateIfSameBuild(worker(null), "/assets/a.js")).toBe(false);
  });
});

describe("« Recharger » (applyUpdateWith)", () => {
  function page(controller: unknown = null) {
    const listeners: (() => void)[] = [];
    const reload = vi.fn();
    const container = {
      controller,
      addEventListener: (type: string, listener: () => void) => {
        if (type === "controllerchange") listeners.push(listener);
      },
    } as unknown as ServiceWorkerContainer;
    return {
      env: { container, reload },
      reload,
      controllerChange: () => {
        for (const l of listeners) l();
      },
    };
  }

  const worker = (state: ServiceWorkerState) => ({
    state,
    postMessage: vi.fn(),
  });

  it("asks a waiting worker to take over, then reloads under it", () => {
    const p = page();
    const w = worker("installed");
    applyUpdateWith(w, p.env);
    expect(w.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(p.reload).not.toHaveBeenCalled();
    p.controllerChange();
    expect(p.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at once when the worker already took over (a late same-build answer)", () => {
    for (const state of ["activating", "activated"] as const) {
      const p = page();
      const w = worker(state);
      applyUpdateWith(w, p.env);
      expect(p.reload).toHaveBeenCalledTimes(1);
      expect(w.postMessage).not.toHaveBeenCalled();
    }
    const w = worker("installed");
    const p = page(w);
    applyUpdateWith(w, p.env);
    expect(p.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when no worker waits", () => {
    const p = page();
    applyUpdateWith(null, p.env);
    expect(p.reload).toHaveBeenCalledTimes(1);
  });
});
