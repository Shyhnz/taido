/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Ring } from "../../bindings";
import {
  displayPriority,
  PriorityRing,
  priorityRingLabel,
} from "./PriorityRing";
import { StateDot } from "./StateDot";

describe("StateDot (Claude's state right of the title)", () => {
  const CASES: [Ring, string, string][] = [
    ["starting", "Démarrage de Claude Code", "var(--state-working)"],
    ["working", "Claude travaille", "var(--state-working)"],
    ["waiting", "Claude attend ta réponse", "var(--state-waiting)"],
    ["done", "Claude a fini", "var(--state-done)"],
    ["error", "Erreur", "var(--state-crashed)"],
    ["crashed", "Session arrêtée", "var(--state-crashed)"],
  ];

  it.each(CASES)("draws %s as a %s dot", (ring, label, color) => {
    render(<StateDot ring={ring} />);
    const dot = screen.getByRole("img", { name: label });
    expect(dot).toHaveAttribute("data-state-dot", ring);
    expect(dot).toHaveAttribute("title", label);
    const fills = Array.from(dot.querySelectorAll("circle")).map((c) =>
      c.getAttribute("fill"),
    );
    expect(fills).toContain(color);
  });

  it("animates working (breathing) and waiting (pulse + halo) only", () => {
    const { rerender, container } = render(<StateDot ring="working" />);
    expect(container.querySelector(".state-dot-breathe")).not.toBeNull();
    rerender(<StateDot ring="waiting" />);
    expect(container.querySelector(".state-dot-pulse")).not.toBeNull();
    expect(container.querySelector(".state-dot-halo")).not.toBeNull();
    rerender(<StateDot ring="done" />);
    expect(container.querySelector("[class^='state-dot-']")).toBeNull();
  });

  it("draws a « ! » for errors and a dotted gray circle when idle", () => {
    const { rerender, container } = render(<StateDot ring="error" />);
    expect(container.querySelector("path")).not.toBeNull();
    rerender(<StateDot ring="idle" />);
    const circle = container.querySelector("circle");
    expect(circle).toHaveAttribute("stroke", "var(--state-idle)");
    expect(circle).toHaveAttribute("stroke-dasharray");
    expect(screen.getByRole("img", { name: "Session ouverte, prête" }));
  });

  it.each<Ring>(["human", "completed", "paused"])(
    "draws nothing for %s",
    (ring) => {
      const { container } = render(<StateDot ring={ring} />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("takes a size", () => {
    render(<StateDot ring="done" size={10} />);
    const svg = screen.getByRole("img").querySelector("svg");
    expect(svg).toHaveAttribute("width", "10");
  });

  it("stops every animation with « réduire les animations »", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/features/task-row/stateDot.css"),
      "utf8",
    );
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    for (const cls of [
      ".state-dot-breathe",
      ".state-dot-pulse",
      ".state-dot-halo",
    ]) {
      expect(reduced).toContain(cls);
    }
    expect(reduced).toContain("animation: none");
  });
});

describe("PriorityRing (Todoist's checkbox)", () => {
  it.each([
    [1, false, "Terminer"],
    [3, false, "Terminer · Priorité 2"],
    [4, false, "Terminer · Priorité 1"],
    [4, true, "Rouvrir"],
  ])("names stored priority %i (completed %s) « %s »", (p, done, name) => {
    expect(priorityRingLabel(p, done)).toBe(name);
  });

  it.each([
    [4, 1],
    [3, 2],
    [2, 3],
    [1, 4],
    [9, 4],
  ])(
    "shows stored priority %i as P%i (P1 the most urgent)",
    (stored, shown) => {
      expect(displayPriority(stored)).toBe(shown);
    },
  );

  it("is a button that toggles, with a check once completed", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <PriorityRing
        priority={2}
        completed={false}
        size={20}
        onToggle={onToggle}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Terminer · Priorité 3",
    });
    expect(button).toHaveAttribute("title", "Priorité 3");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <PriorityRing priority={2} completed size={20} onToggle={onToggle} />,
    );
    const svg = screen
      .getByRole("button", { name: "Rouvrir" })
      .querySelector("svg");
    expect(svg).toHaveAttribute("data-completed", "true");
    expect(svg?.querySelector("[data-part='check']")).not.toBeNull();
    expect(svg?.querySelector("[data-part='base']")).toHaveAttribute(
      "fill",
      "var(--priority-2)",
    );
  });

  it("is a plain drawing without onToggle, at the asked size", () => {
    const { container } = render(
      <PriorityRing priority={4} completed={false} size={15} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "15");
    expect(svg).toHaveAttribute("data-priority", "4");
  });

  it("draws an unknown priority as the plain one", () => {
    const { container } = render(
      <PriorityRing priority={9} completed={false} size={20} />,
    );
    expect(container.querySelector("svg")).toHaveAttribute(
      "data-priority",
      "1",
    );
    const { container: low } = render(
      <PriorityRing priority={0} completed={false} size={20} />,
    );
    expect(low.querySelector("svg")).toHaveAttribute("data-priority", "1");
  });
});
