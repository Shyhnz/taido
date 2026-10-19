/**
 * The Android back button (or gesture) closes the topmost overlay of the phone app (dialog,
 * task sheet, drawer) instead of leaving the app. In a standalone PWA, « back » walks the
 * page's history: each open overlay owns one history entry, pushed when it opens; « back »
 * pops it (`popstate`) and closes that overlay. An overlay closed by the UI (its own button)
 * removes its entry with `history.go`, whose `popstate` is ignored.
 */

import { useEffect, useRef } from "react";

const MARK = { todoOverlay: true };

/**
 * `depth`: number of overlays open, one above the other. `closeTop`: closes the topmost one
 * (the depth then drops by one).
 */
export function useBackCloses(depth: number, closeTop: () => void): void {
  const entries = useRef(0);
  const ignored = useRef(0);
  const close = useRef(closeTop);
  close.current = closeTop;

  useEffect(() => {
    if (depth > entries.current) {
      for (let i = entries.current; i < depth; i += 1) {
        window.history.pushState(MARK, "");
      }
      entries.current = depth;
    } else if (depth < entries.current) {
      const extra = entries.current - depth;
      entries.current = depth;
      ignored.current += 1;
      window.history.go(-extra);
    }
  }, [depth]);

  useEffect(() => {
    const onPop = () => {
      if (ignored.current > 0) {
        ignored.current -= 1;
        return;
      }
      if (entries.current === 0) return;
      entries.current -= 1;
      close.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
