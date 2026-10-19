import { useEffect } from "react";
import type { Settings } from "../bindings";
import { reconcileLanguage } from "./index";

/** Keeps the core's language and this window's in step (see `reconcileLanguage`). */
export function useLanguageSync(settings: Settings | undefined): void {
  useEffect(() => {
    // Cheap and idempotent: it returns at once when both already agree.
    if (settings) void reconcileLanguage(settings);
  }, [settings]);
}
