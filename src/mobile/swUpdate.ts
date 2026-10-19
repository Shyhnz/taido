/**
 * Service worker registration and the « Une nouvelle version est prête » flow
 * (docs/SYNC.md § 6.5): a new worker that finished installing while a controller exists
 * waits; « Recharger » asks it to skip waiting and reloads once it controls the page.
 *
 * V2.7 bis: a waiting worker of this very build (the page came from the network while the
 * previous worker still controlled it) is activated at once, without the banner: until then
 * an offline opening would get the previous build's cached app.
 */

import { create } from "zustand";

interface SwUpdateState {
  waiting: ServiceWorker | null;
}

export const useSwUpdate = create<SwUpdateState>(() => ({ waiting: null }));

/** A script of this build, as the worker pre-caches it (`/assets/…`). */
const OWN_PATH = new URL(import.meta.url).pathname;
/** An older worker never answers: the banner is shown after this long. */
const ANSWER_TIMEOUT_MS = 1000;

/** Asks the waiting worker to activate when it is this page's build; whether it does. */
export function activateIfSameBuild(
  worker: Pick<ServiceWorker, "postMessage">,
  path: string = OWN_PATH,
): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, ANSWER_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve((event.data as { skipping?: unknown })?.skipping === true);
    };
    worker.postMessage({ type: "SKIP_WAITING_IF_SAME_BUILD", path }, [
      channel.port2,
    ]);
  });
}

/** A worker waits: activated at once when it is this build, else « Recharger » is offered. */
function offer(worker: ServiceWorker): void {
  void activateIfSameBuild(worker).then((skipping) => {
    if (!skipping) useSwUpdate.setState({ waiting: worker });
  });
}

function watch(registration: ServiceWorkerRegistration): void {
  const container = navigator.serviceWorker;
  if (registration.waiting && container.controller) {
    offer(registration.waiting);
  }
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && container.controller) {
        offer(installing);
      }
    });
  });
}

/** Registers `/sw.js` (production builds only). Failures are logged, never fatal. */
export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    watch(registration);
  } catch (error) {
    console.warn("service worker registration failed", error);
  }
}

/** What « Recharger » needs from the page (tests pass fakes). */
export interface UpdateEnv {
  container: Pick<ServiceWorkerContainer, "controller" | "addEventListener">;
  reload: () => void;
}

/** « Recharger »: activates the waiting worker, then reloads under it. */
export function applyUpdate(): void {
  applyUpdateWith(useSwUpdate.getState().waiting, {
    container: navigator.serviceWorker,
    reload: () => window.location.reload(),
  });
}

/**
 * The worker may already be taking over: it answered the same-build question after the page
 * stopped waiting for it (`activateIfSameBuild`) and skipped waiting, or another page asked it.
 * Its `controllerchange` has then happened or is about to without this page listening: reload
 * at once instead of waiting for it.
 */
export function applyUpdateWith(
  waiting: Pick<ServiceWorker, "state" | "postMessage"> | null,
  env: UpdateEnv,
): void {
  if (
    !waiting ||
    waiting.state === "activating" ||
    waiting.state === "activated" ||
    waiting.state === "redundant" ||
    env.container.controller === waiting
  ) {
    env.reload();
    return;
  }
  env.container.addEventListener("controllerchange", () => env.reload(), {
    once: true,
  });
  waiting.postMessage({ type: "SKIP_WAITING" });
}
