/**
 * One page of the app at a time. The installed app and a Chrome tab
 * on the same origin share one IndexedDB, and every save writes the whole persisted set: two
 * live pages would overwrite each other's unsent edits. A page holds the exclusive Web Lock
 * `todo-app` for its whole life and loads the persisted set only once it holds it:
 *
 * - free → `held` (the page boots);
 * - held by another page → `busy`: the page offers « Utiliser ici », which steals the lock
 *   (`steal: true`) and then boots, loading the set the other page last saved;
 * - the page whose lock was stolen gets `onLost` (its lock request rejects with an
 *   `AbortError`, Web Locks spec): it stops saving and syncing (`MobileBackend.suspend`).
 *
 * Without the API (old browsers, tests) the page boots unguarded (`unsupported`).
 */

export const INSTANCE_LOCK = "todo-app";

export type LockOutcome = "held" | "busy" | "unsupported";

/** The part of `LockManager` used here. */
export interface Locks {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

export function acquireInstanceLock(
  locks: Locks | undefined,
  options: { steal: boolean; onLost: () => void },
): Promise<LockOutcome> {
  return new Promise((resolve) => {
    if (!locks) {
      resolve("unsupported");
      return;
    }
    const request = locks.request(
      INSTANCE_LOCK,
      options.steal ? { steal: true } : { ifAvailable: true },
      (lock) => {
        if (!lock) {
          resolve("busy");
          return undefined;
        }
        resolve("held");
        // Held until the page goes away.
        return new Promise<void>(() => {});
      },
    );
    request.catch((error: unknown) => {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "AbortError") {
        options.onLost();
      } else {
        console.warn("instance lock failed, running unguarded", error);
        resolve("unsupported");
      }
    });
  });
}
