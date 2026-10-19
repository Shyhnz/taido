/**
 * Screens of `instanceLock.ts`: another page holds the app (« Utiliser ici »), or this page
 * was taken over (« Recharger »). Plain elements: main.tsx renders them before the app, and
 * nothing it imports may load src/lib/ipc.ts.
 */

import { useState } from "react";
import { fr } from "../i18n/fr";

const buttonClass =
  "h-11 rounded-md bg-accent px-4 text-[15px] font-medium text-on-accent disabled:opacity-60";

function Screen({
  title,
  help,
  action,
  onAction,
}: {
  title: string;
  help?: string;
  action: string;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <main className="mobile flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-text">
      <p role="alert" className="max-w-[360px] text-[16px] font-medium">
        {title}
      </p>
      {help && <p className="max-w-[360px] text-[14px] text-text-2">{help}</p>}
      <button
        type="button"
        className={buttonClass}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onAction();
        }}
      >
        {action}
      </button>
    </main>
  );
}

export function OtherPageScreen({ onUseHere }: { onUseHere: () => void }) {
  return (
    <Screen
      title={fr.mobile.otherPage}
      help={fr.mobile.otherPageHelp}
      action={fr.mobile.useHere}
      onAction={onUseHere}
    />
  );
}

export function TakenOverScreen({ onReload }: { onReload: () => void }) {
  return (
    <Screen
      title={fr.mobile.pageTakenOver}
      action={fr.mobile.reload}
      onAction={onReload}
    />
  );
}
