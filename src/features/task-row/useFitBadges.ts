/**
 * Keeps a row's badges whole on a narrow screen (2026-10-13, on a phone): the badge box
 * never shrinks, the title shrinks down to its minimum, and while the line still overflows the
 * last badge is hidden, the relation icons (`data-relation`) last of all. Measured, not
 * guessed: it holds whatever the text size (Android scales fonts).
 */

import { type RefObject, useLayoutEffect } from "react";

export function useFitBadges(ref: RefObject<HTMLElement | null>): void {
  // No dependency list on purpose: the badges change with every render of the row.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    fitBadges(box);
    if (typeof ResizeObserver === "undefined") return;
    let width = box.parentElement?.clientWidth ?? 0;
    const observer = new ResizeObserver(() => {
      const next = box.parentElement?.clientWidth ?? 0;
      if (next === width) return;
      width = next;
      fitBadges(box);
    });
    if (box.parentElement) observer.observe(box.parentElement);
    return () => observer.disconnect();
  });
}

/** Shows every badge, then hides from the end until the line fits; relation icons go last. */
export function fitBadges(box: HTMLElement): void {
  const line = box.parentElement;
  if (!line) return;
  const badges = Array.from(box.children) as HTMLElement[];
  for (const b of badges) b.style.display = "";
  const queue = [
    ...badges.filter((b) => !b.hasAttribute("data-relation")).reverse(),
    ...badges.filter((b) => b.hasAttribute("data-relation")).reverse(),
  ];
  for (const b of queue) {
    if (line.scrollWidth <= line.clientWidth) return;
    b.style.display = "none";
  }
}
