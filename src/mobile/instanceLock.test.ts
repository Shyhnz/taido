import { describe, expect, it, vi } from "vitest";
import { acquireInstanceLock, type Locks } from "./instanceLock";
import { link, makePhone } from "./test/helpers";

/** An exclusive lock manager with `ifAvailable` and `steal` (Web Locks semantics). */
class FakeLocks implements Locks {
  private holder: { reject: (e: unknown) => void } | null = null;

  request(
    _name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.holder && options.ifAvailable) {
        resolve(callback(null));
        return;
      }
      if (this.holder && options.steal) {
        const abort = new Error("stolen");
        abort.name = "AbortError";
        this.holder.reject(abort);
      }
      this.holder = { reject };
      Promise.resolve(callback({ name: "todo-app" })).then(resolve, reject);
    });
  }
}

describe("one page of the app at a time", () => {
  it("lets the first page in, tells the second, and suspends the first on a takeover", async () => {
    const locks = new FakeLocks();
    const lostA = vi.fn();
    const lostB = vi.fn();
    expect(
      await acquireInstanceLock(locks, { steal: false, onLost: lostA }),
    ).toBe("held");
    expect(
      await acquireInstanceLock(locks, { steal: false, onLost: lostB }),
    ).toBe("busy");
    expect(
      await acquireInstanceLock(locks, { steal: true, onLost: lostB }),
    ).toBe("held");
    await Promise.resolve();
    expect(lostA).toHaveBeenCalledTimes(1);
    expect(lostB).not.toHaveBeenCalled();
  });

  it("runs unguarded without the API", async () => {
    expect(
      await acquireInstanceLock(undefined, { steal: false, onLost: vi.fn() }),
    ).toBe("unsupported");
  });

  it("a suspended page never saves nor syncs again", async () => {
    const phone = makePhone();
    const { backend, store, server } = phone;
    await link(phone);
    const sent = server.requests.length;
    const save = vi.spyOn(store, "save");
    backend.suspend();
    await backend.commands.createTask({
      title: "Pas enregistrée ici",
      description: null,
      subjectId: null,
      sectionId: null,
      dueDate: null,
      dueTime: null,
    });
    await backend.saveNow();
    await new Promise((r) => setTimeout(r, 400));
    expect(save).not.toHaveBeenCalled();
    await backend.engine.trigger();
    expect(server.requests.length).toBe(sent);
  });
});
