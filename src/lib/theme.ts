/**
 * Applies the theme settings to <html>: `data-theme` light or dark (system follows
 * prefers-color-scheme), `data-color` the colour theme (src/styles/tokens.css).
 */

import { useEffect, useSyncExternalStore } from "react";
import type { ColorTheme, Theme } from "../bindings";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export const THEMES: Theme[] = ["light", "dark", "system"];

/** Réglages › Thème, in the order shown; « taido » is the default. */
export const COLOR_THEMES: ColorTheme[] = [
  "taido",
  "slate",
  "graphite",
  "blueberry",
  "lavender",
  "plum",
  "raspberry",
  "cocoa",
  "sage",
  "lagoon",
];

export function resolveTheme(
  theme: Theme,
  prefersDark: boolean,
): "light" | "dark" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

function subscribeToScheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Light or dark as shown now (« Système » follows the device). */
export function useResolvedTheme(theme: Theme): "light" | "dark" {
  const prefersDark = useSyncExternalStore(
    subscribeToScheme,
    systemPrefersDark,
  );
  return resolveTheme(theme, prefersDark);
}

export function useApplyTheme(theme: Theme, color: ColorTheme): void {
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.color === color) return;
    root.classList.add("theme-switching");
    root.dataset.color = color;
    const timer = setTimeout(
      () => root.classList.remove("theme-switching"),
      50,
    );
    return () => clearTimeout(timer);
  }, [color]);
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      const next = resolveTheme(theme, systemPrefersDark());
      if (root.dataset.theme === next) return;
      // No color transitions while the whole palette switches.
      root.classList.add("theme-switching");
      root.dataset.theme = next;
      setTimeout(() => root.classList.remove("theme-switching"), 50);
    };
    apply();
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
