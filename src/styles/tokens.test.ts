/**
 * Contrast of the design tokens: every text/background pair the UI
 * uses is >= 4.5:1, every UI glyph (rings, borders of fields, focus ring, active bar) >= 3:1,
 * in both themes. The values are read from tokens.css itself.
 */

/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest runs from the project root (`css: false` empties `?raw` CSS imports).
const css = readFileSync(
  resolve(process.cwd(), "src/styles/tokens.css"),
  "utf8",
);

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector} block`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const vars: Record<string, string> = {};
  for (const m of css
    .slice(open + 1, close)
    .matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

const light = block(':root,\n[data-theme="light"]');
// The dark block only overrides; the rest is inherited from :root.
const dark = { ...light, ...block('[data-theme="dark"]') };

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  const channel = (i: number) => {
    const v = Number.parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  "bg",
  "bg-sidebar",
  "bg-aside",
  "bg-hover",
  "bg-selected",
  "bg-sidebar-hover",
  "bg-elevated",
];

/** [foreground, background] pairs of text: 4.5:1. */
const TEXT_PAIRS: [string, string][] = [
  ...["text", "text-2", "text-3"].flatMap((fg) =>
    SURFACES.map((bg): [string, string] => [fg, bg]),
  ),
  ["text-nav-active", "bg-nav-active"],
  ["text-2", "bg-nav-active"],
  ["on-accent", "accent"],
  ["on-state-waiting", "state-waiting"],
  ["bg", "text"], // toasts
  ["state-waiting-text", "bg"],
  ["state-waiting-text", "state-waiting-fill"],
  ["state-waiting-text", "bar-waiting"],
  ["state-done-text", "bg"],
  ["state-done-text", "bar-done"],
  ...["bg", "bg-hover", "bg-selected", "bg-aside"].map(
    (bg): [string, string] => ["due-overdue", bg],
  ),
  // Quick add tokens, and the unknown project (no background).
  ["token-project-text", "token-project-bg"],
  ["token-agent-text", "token-agent-bg"],
  ["token-date-text", "token-date-bg"],
  ["token-project-text", "bg-elevated"],
];

/** [glyph, background] pairs of UI components: 3:1 (WCAG 1.4.11). */
const UI_PAIRS: [string, string][] = [
  ...["bg", "bg-hover", "bg-selected", "bg-aside"].flatMap((bg) =>
    [
      "state-idle",
      "state-working",
      "state-waiting",
      "state-done",
      "state-crashed",
      "state-completed",
    ].map((fg): [string, string] => [fg, bg]),
  ),
  // Priority outlines, on the list surfaces and on their own fill.
  ...["bg", "bg-hover", "bg-selected", "bg-aside"].flatMap((bg) =>
    ["priority-1", "priority-2", "priority-3", "priority-4"].map(
      (fg): [string, string] => [fg, bg],
    ),
  ),
  ["priority-2", "priority-2-fill"],
  ["priority-3", "priority-3-fill"],
  ["priority-4", "priority-4-fill"],
  // The check of a completed task, drawn on the priority colour.
  ["ring-check-on-fill", "priority-2"],
  ["ring-check-on-fill", "priority-3"],
  ["ring-check-on-fill", "priority-4"],
  ["ring-check-on-fill", "state-completed"],
  ["border-input", "bg"],
  ["border-input", "bg-elevated"],
  ["focus", "bg"],
  ["focus", "bg-sidebar"],
  ["accent", "bg-nav-active"], // active bar of the sidebar
];

/** Colour themes (Réglages › Thème): each overrides the light and the dark tokens. */
const COLORS = [
  ...css.matchAll(/\[data-theme="light"\]\[data-color="([a-z]+)"\]/g),
].map((m) => m[1]);

const THEMES: [string, Record<string, string>][] = [
  ["light", light],
  ["dark", dark],
  ...COLORS.flatMap((c): [string, Record<string, string>][] => [
    [
      `light ${c}`,
      { ...light, ...block(`[data-theme="light"][data-color="${c}"]`) },
    ],
    [
      `dark ${c}`,
      { ...dark, ...block(`[data-theme="dark"][data-color="${c}"]`) },
    ],
  ]),
];

it("has the nine colour themes besides Taido", () => {
  expect(COLORS).toEqual([
    "slate",
    "graphite",
    "blueberry",
    "lavender",
    "plum",
    "raspberry",
    "cocoa",
    "sage",
    "lagoon",
  ]);
});

describe.each(THEMES)("%s theme tokens", (_name, tokens) => {
  const value = (name: string) => {
    const v = tokens[name];
    if (!v) throw new Error(`missing token --${name}`);
    return v;
  };

  it.each(TEXT_PAIRS)("text --%s on --%s is >= 4.5:1", (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(UI_PAIRS)("glyph --%s on --%s is >= 3:1", (fg, bg) => {
    expect(contrast(value(fg), value(bg))).toBeGreaterThanOrEqual(3);
  });

  it("keeps the sidebar hover distinct from the sidebar and the active item (B1)", () => {
    expect(value("bg-sidebar-hover")).not.toBe(value("bg-sidebar"));
    expect(value("bg-sidebar-hover")).not.toBe(value("bg-nav-active"));
  });

  it("keeps the priority colours apart from the Claude state colours", () => {
    const states = [
      "state-working",
      "state-waiting",
      "state-done",
      "state-crashed",
    ].map(value);
    for (const p of ["priority-2", "priority-3", "priority-4"]) {
      expect(states).not.toContain(value(p));
    }
  });

  it("keeps overdue dates off the « Claude attend » red (D8)", () => {
    expect(value("due-overdue")).not.toBe(value("state-waiting"));
    expect(value("due-overdue")).not.toBe(value("state-waiting-text"));
  });
});

describe("contrast()", () => {
  it("matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#a3a39e", "#ffffff")).toBeCloseTo(2.53, 2);
  });
});
