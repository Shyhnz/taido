import { beforeEach, describe, expect, it } from "vitest";
import {
  ASK_PANEL,
  fitPanelWidth,
  maxPanelWidth,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  readPanelWidth,
  SIDEBAR_WIDTH,
  writePanelWidth,
} from "./panelWidth";

describe("panel width (bug #7)", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the wanted width when the window is wide enough", () => {
    expect(fitPanelWidth(460, 1440)).toBe(460);
    expect(fitPanelWidth(700, 1440)).toBe(700);
  });

  it("clamps to the bounds", () => {
    expect(fitPanelWidth(100, 1440)).toBe(PANEL_MIN);
    expect(fitPanelWidth(5000, 3000)).toBe(PANEL_MAX);
    expect(fitPanelWidth(Number.NaN, 1440)).toBe(PANEL_DEFAULT);
  });

  it("caps a remembered width to the space left by the sidebar and the list", () => {
    // Window at its minimum width (1100): 1100 - 248 - 320.
    expect(fitPanelWidth(1000, 1100)).toBe(532);
  });

  it("never gets wider than the room next to the sidebar, so × stays visible", () => {
    for (const viewport of [400, 600, 700, 900, 1100, 1440]) {
      const width = fitPanelWidth(1000, viewport);
      expect(width).toBeLessThanOrEqual(viewport - SIDEBAR_WIDTH);
      expect(width).toBe(maxPanelWidth(viewport));
    }
  });

  it("remembers the width in local storage", () => {
    expect(readPanelWidth()).toBe(PANEL_DEFAULT);
    writePanelWidth(512.4);
    expect(readPanelWidth()).toBe(512);
    window.localStorage.setItem("todo.panelWidth", "nope");
    expect(readPanelWidth()).toBe(PANEL_DEFAULT);
  });

  it("keeps the questions panel's width apart (420 px by default)", () => {
    window.localStorage.clear();
    expect(readPanelWidth(ASK_PANEL)).toBe(420);
    writePanelWidth(600, ASK_PANEL);
    expect(readPanelWidth(ASK_PANEL)).toBe(600);
    expect(readPanelWidth()).toBe(PANEL_DEFAULT);
  });
});
