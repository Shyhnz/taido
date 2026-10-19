import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Ring } from "../../bindings";
import { PriorityRing } from "./PriorityRing";
import { hasStateDot, StateDot } from "./StateDot";

describe("PriorityRing", () => {
  it.each([
    [1, "var(--priority-1)", "none"],
    [2, "var(--priority-2)", "var(--priority-2-fill)"],
    [3, "var(--priority-3)", "var(--priority-3-fill)"],
    [4, "var(--priority-4)", "var(--priority-4-fill)"],
  ])(
    "draws priority %i with its outline and a tinted inside",
    (p, stroke, fill) => {
      const { container } = render(
        <PriorityRing priority={p} completed={false} size={20} />,
      );
      const base = container.querySelector('[data-part="base"]');
      expect(base).toHaveAttribute("stroke", stroke);
      expect(base?.getAttribute("fill")).toContain(fill);
      expect(container.querySelector('[data-part="check"]')).toBeNull();
      // Without `onToggle`, a plain picture.
      expect(screen.queryByRole("button")).toBeNull();
    },
  );

  it("shows a check once completed", () => {
    const { container } = render(
      <PriorityRing priority={3} completed size={20} />,
    );
    expect(container.querySelector('[data-part="check"]')).not.toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute(
      "data-completed",
      "true",
    );
  });

  it("is a button with onToggle, named after the priority", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <PriorityRing
        priority={1}
        completed={false}
        size={24}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Terminer" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <PriorityRing
        priority={4}
        completed={false}
        size={24}
        onToggle={onToggle}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Terminer · Priorité 1" }),
    ).toBeInTheDocument();
    rerender(
      <PriorityRing priority={4} completed size={24} onToggle={onToggle} />,
    );
    expect(screen.getByRole("button", { name: "Rouvrir" })).toBeInTheDocument();
  });

  it("reads an unknown priority as 1", () => {
    const { container } = render(
      <PriorityRing priority={9} completed={false} size={15} />,
    );
    expect(container.querySelector("svg")).toHaveAttribute(
      "data-priority",
      "1",
    );
  });
});

describe("StateDot", () => {
  const running: Ring[] = [
    "starting",
    "working",
    "waiting",
    "done",
    "idle",
    "error",
    "crashed",
  ];

  it.each(running)("shows a dot named after the state for %s", (ring) => {
    render(<StateDot ring={ring} />);
    const dot = screen.getByRole("img");
    expect(dot).toHaveAttribute("data-state-dot", ring);
    expect(dot).toHaveAccessibleName();
    expect(hasStateDot(ring)).toBe(true);
  });

  it.each(["human", "completed", "paused"] as Ring[])(
    "shows nothing without a running Claude (%s)",
    (ring) => {
      const { container } = render(<StateDot ring={ring} />);
      expect(container).toBeEmptyDOMElement();
      expect(hasStateDot(ring)).toBe(false);
    },
  );

  it("pulses while Claude waits, breathes while it works", () => {
    const { container, rerender } = render(<StateDot ring="waiting" />);
    expect(container.querySelector(".state-dot-pulse")).toHaveAttribute(
      "fill",
      "var(--state-waiting)",
    );
    rerender(<StateDot ring="working" />);
    expect(container.querySelector(".state-dot-breathe")).not.toBeNull();
    rerender(<StateDot ring="done" />);
    const circle = container.querySelector("circle");
    expect(circle?.getAttribute("class")).toBeNull();
    expect(circle).toHaveAttribute("fill", "var(--state-done)");
  });
});
