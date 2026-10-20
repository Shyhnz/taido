/**
 * Screen width of the web app (site and phone). « Grand écran » is a viewport of
 * at least 1024 px, re-evaluated on resize: the portfolio and the CSV export show from there,
 * and the kanban puts its columns side by side; below, it shows one column per screen. On
 * the Mac (not `IS_MOBILE`) the screen is always large.
 */

import { useCallback, useSyncExternalStore } from "react";
import { IS_MOBILE } from "./target";

/** Width from which the web app is « grand écran ». */
export const LARGE_QUERY = "(min-width: 1024px)";

function matches(query: string): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(query).matches ?? false;
}

/** True while `query` matches; follows its `change` events. */
export function useMediaQuery(query: string): boolean {
  // Stable per query: React resubscribes only when the query changes.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matches(query),
    () => false,
  );
}

/** True on the Mac, and on the web from 1024 px wide. */
export function useLargeScreen(): boolean {
  const large = useMediaQuery(LARGE_QUERY);
  return !IS_MOBILE || large;
}
