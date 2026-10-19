/**
 * Entry of the installable web app (docs/SYNC.md § 6.1). Takes the single-page lock
 * (instanceLock.ts), then loads the persisted backend,
 * hands it to src/lib/ipc.ts through `globalThis.__TODO_BACKEND__`, and only then imports the
 * app (so ipc.ts never builds its own mock backend). Nothing imported statically here may
 * import src/lib/ipc.ts.
 */

import "./mobile.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { showToast } from "../components/Toast";
import { t } from "../i18n";
import { guardStrayDrops } from "../lib/web-files";
import { createMobileBackend, type MobileBackend } from "./backend";
import { OtherPageScreen, TakenOverScreen } from "./InstanceScreens";
import { acquireInstanceLock, type Locks } from "./instanceLock";

const rootElement = document.getElementById("root");
const root = rootElement ? ReactDOM.createRoot(rootElement) : null;
let backend: MobileBackend | null = null;

/** Another page stole the lock: this one stops writing and says so. */
function onLost(): void {
  backend?.suspend();
  root?.render(<TakenOverScreen onReload={() => window.location.reload()} />);
}

/** One page of the app at a time (instanceLock.ts); then boots. */
async function start(): Promise<void> {
  const locks = (navigator as { locks?: Locks }).locks;
  const outcome = await acquireInstanceLock(locks, { steal: false, onLost });
  if (outcome !== "busy") {
    await boot();
    return;
  }
  root?.render(
    <OtherPageScreen
      onUseHere={() => {
        void acquireInstanceLock(locks, { steal: true, onLost }).then(() =>
          boot(),
        );
      }}
    />,
  );
}

async function boot(): Promise<void> {
  if (navigator.storage?.persist) {
    try {
      const persisted = await navigator.storage.persist();
      console.info(`storage: persistent = ${persisted}`);
    } catch (error) {
      console.warn("storage: persist() failed", error);
    }
  }

  // Loaded only once the lock is held: the set the previous page saved last.
  backend = await createMobileBackend({
    onStorageError: () => showToast({ message: t.mobile.storageError }),
  });
  globalThis.__TODO_BACKEND__ = backend;

  const { default: MobileApp } = await import("./MobileApp");
  root?.render(
    <React.StrictMode>
      <MobileApp backend={backend} />
    </React.StrictMode>,
  );

  backend.engine.start({ window, document });
  // A file dropped beside « Pièces jointes » never replaces the app.
  guardStrayDrops(window);

  if (import.meta.env.PROD) {
    const { registerServiceWorker } = await import("./swUpdate");
    await registerServiceWorker();
  }
}

void start();
