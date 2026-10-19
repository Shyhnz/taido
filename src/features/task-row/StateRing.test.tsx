/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Ring } from "../../bindings";
import { RingSvg, StateRing } from "./StateRing";

const parts = (svg: Element) =>
  Array.from(svg.querySelectorAll("[data-part]"))
    .map((el) => el.getAttribute("data-part"))
    .filter((p) => p !== "preview");

const CASES: {
  ring: Ring;
  parts: string[];
  fill: string;
  stroke: string;
  dash: string | null;
  label: string;
}[] = [
  {
    ring: "human",
    parts: ["base"],
    fill: "none",
    stroke: "var(--state-idle)",
    dash: null,
    label: "Terminer",
  },
  {
    ring: "completed",
    parts: ["base", "check"],
    fill: "var(--state-completed)",
    stroke: "var(--state-completed)",
    dash: null,
    label: "Rouvrir",
  },
  {
    ring: "starting",
    parts: ["base", "arc"],
    fill: "none",
    stroke: "var(--state-working-track)",
    dash: null,
    label: "Terminer · Démarrage de Claude Code",
  },
  {
    ring: "working",
    parts: ["base", "arc"],
    fill: "none",
    stroke: "var(--state-working-track)",
    dash: null,
    label: "Terminer · Claude travaille",
  },
  {
    ring: "waiting",
    parts: ["base", "dot"],
    fill: "var(--state-waiting-fill)",
    stroke: "var(--state-waiting)",
    dash: null,
    label: "Terminer · Claude attend ta réponse",
  },
  {
    ring: "done",
    // A still green dot, never a check: only the user completes a task.
    parts: ["base", "dot"],
    fill: "var(--bar-done)",
    stroke: "var(--state-done)",
    dash: null,
    label: "Terminer · Claude a fini",
  },
  {
    ring: "idle",
    parts: ["base"],
    fill: "none",
    stroke: "var(--state-idle)",
    dash: "2 2.6",
    label: "Terminer · Session ouverte, prête",
  },
  {
    ring: "paused",
    parts: ["base"],
    fill: "none",
    stroke: "var(--state-idle)",
    dash: "2 2.6",
    label: "Terminer · Session en pause",
  },
  {
    ring: "error",
    parts: ["base", "bang"],
    fill: "none",
    stroke: "var(--state-crashed)",
    dash: null,
    label: "Terminer · Erreur",
  },
  {
    ring: "crashed",
    parts: ["base", "bang"],
    fill: "none",
    stroke: "var(--state-crashed)",
    dash: null,
    label: "Terminer · Session arrêtée",
  },
];

describe("StateRing", () => {
  it.each(CASES)("renders $ring", (c) => {
    render(<StateRing ring={c.ring} />);
    const button = screen.getByRole("button", { name: c.label });
    const svg = button.querySelector("svg");
    if (!svg) throw new Error("no svg");
    expect(svg.getAttribute("data-ring")).toBe(c.ring);
    expect(svg.getAttribute("viewBox")).toBe("0 0 20 20");
    expect(parts(svg)).toEqual(c.parts);
    const base = svg.querySelector('[data-part="base"]');
    expect(base?.getAttribute("r")).toBe("8.4");
    expect(base?.getAttribute("stroke-width")).toBe("1.6");
    expect(base?.getAttribute("fill")).toBe(c.fill);
    expect(base?.getAttribute("stroke")).toBe(c.stroke);
    expect(base?.getAttribute("stroke-dasharray")).toBe(c.dash);
  });

  it("uses the spec geometry for the animated parts", () => {
    const { container } = render(
      <>
        <RingSvg ring="working" size={20} />
        <RingSvg ring="waiting" size={20} />
      </>,
    );
    const arc = container.querySelector('[data-part="arc"]');
    expect(arc?.getAttribute("class")).toBe("ring-spin");
    const arcCircle = arc?.querySelector("circle");
    expect(arcCircle?.getAttribute("stroke-dasharray")).toBe("16 40");
    expect(arcCircle?.getAttribute("transform")).toBe("rotate(-90 10 10)");
    const dot = container.querySelector('[data-part="dot"]');
    expect(dot?.getAttribute("r")).toBe("3.4");
    expect(dot?.getAttribute("class")).toBe("ring-pulse");
  });

  it("animates and stops for reduced motion", () => {
    // Vitest runs from the project root (`css: false` empties CSS imports).
    const css = readFileSync(
      resolve(process.cwd(), "src/styles/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.ring-spin\s*{[^}]*animation:\s*ring-spin 1\.2s linear infinite/,
    );
    expect(css).toMatch(
      /\.ring-pulse\s*{[^}]*animation:\s*ring-pulse 1\.4s ease-in-out infinite/,
    );
    expect(css).toMatch(/50%\s*{\s*opacity:\s*0\.35;/);
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(reduced).toMatch(
      /\.ring-spin,\s*\.ring-pulse\s*{\s*animation:\s*none;/,
    );
  });

  it("supports the three sizes", () => {
    const { container } = render(
      <>
        <RingSvg ring="human" size={20} />
        <RingSvg ring="human" size={24} />
        <RingSvg ring="human" size={15} />
      </>,
    );
    const sizes = Array.from(container.querySelectorAll("svg")).map((s) =>
      s.getAttribute("width"),
    );
    expect(sizes).toEqual(["20", "24", "15"]);
  });

  it("shows a check preview on hover for open human rings only", () => {
    const { container } = render(
      <>
        <StateRing ring="human" />
        <StateRing ring="completed" />
      </>,
    );
    expect(container.querySelectorAll('[data-part="preview"]')).toHaveLength(1);
  });

  it("toggles on click with a 28 px hit area", () => {
    const onToggle = vi.fn();
    render(<StateRing ring="human" onToggle={onToggle} />);
    const button = screen.getByRole("button");
    expect(button.style.width).toBe("28px");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
