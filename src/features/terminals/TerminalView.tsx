/** Visible host of one terminal: the registry moves the terminal's xterm container in here. */

import { useEffect, useRef } from "react";
import { showTerminal } from "./registry";

export function TerminalView({
  terminalId,
  label,
}: {
  terminalId: string;
  /** Accessible name of the region (« Terminal Claude Code »). */
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    return showTerminal(terminalId, host);
  }, [terminalId]);

  return (
    <section
      ref={ref}
      aria-label={label}
      data-terminal-host={terminalId}
      // The padding is the terminal's own background, around xterm's grid.
      className="h-full min-h-0 w-full overflow-hidden bg-terminal px-2 py-1.5"
    />
  );
}
