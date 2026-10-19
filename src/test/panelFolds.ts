/**
 * Test helper for the task panel's folded sections (layout C, 2026-10-11): an empty section
 * hides behind « Ajouter : … », a filled one is a folded row.
 */

import { act, waitFor, within } from "@testing-library/react";

/**
 * Opens the section `title` in `container` and returns it: from « Ajouter : `add` » while it
 * is empty, then unfolds it when it is folded.
 */
export async function openFold(
  container: HTMLElement,
  title: string | RegExp,
  add?: string,
): Promise<HTMLElement> {
  const scope = within(container);
  await waitFor(() => {
    const found =
      scope.queryByRole("region", { name: title }) ??
      (add ? scope.queryByRole("button", { name: add }) : null);
    if (!found) throw new Error(`No section ${String(title)} yet`);
  });
  let region = scope.queryByRole("region", { name: title });
  if (!region && add) {
    const button = scope.getByRole("button", { name: add });
    act(() => button.click());
    region = await scope.findByRole("region", { name: title });
  }
  if (!region) throw new Error(`No section ${String(title)}`);
  const toggle = region.querySelector<HTMLButtonElement>(
    "h2 > button[aria-expanded]",
  );
  if (toggle?.getAttribute("aria-expanded") === "false") {
    act(() => toggle.click());
  }
  return region;
}
