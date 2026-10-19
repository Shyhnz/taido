import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, LiveRegion } from "./LiveRegion";
import {
  showError,
  showToast,
  TOAST_DURATION_MS,
  ToastHost,
  useToasts,
} from "./Toast";

describe("ToastHost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps its live regions mounted when empty", () => {
    render(<ToastHost />);
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getByRole("status")).toBeEmptyDOMElement();
    expect(within(region).getByRole("alert")).toBeEmptyDOMElement();
  });

  it("dismisses an information toast after 5 s", () => {
    render(<ToastHost />);
    act(() => {
      showToast({ message: "Tâche terminée" });
    });
    expect(screen.getByRole("status")).toHaveTextContent("Tâche terminée");
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS);
    });
    expect(screen.queryByText("Tâche terminée")).toBeNull();
  });

  it("keeps an error toast until it is closed (bug #12, audit B3)", () => {
    render(<ToastHost />);
    act(() => {
      showError("Impossible d'ajouter la tâche. Réessaie.");
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Impossible d'ajouter la tâche. Réessaie.");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(alert).toHaveTextContent("Impossible d'ajouter la tâche.");
    act(() => {
      within(alert).getByRole("button", { name: "Fermer" }).click();
    });
    expect(alert).toBeEmptyDOMElement();
  });

  it("honours an explicit duration", () => {
    render(<ToastHost />);
    act(() => {
      showToast({ message: "Tâche supprimée", duration: 8000 });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS);
    });
    expect(screen.getByText("Tâche supprimée")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("Tâche supprimée")).toBeNull();
  });
});

describe("LiveRegion", () => {
  it("announces messages politely, the same text again too", () => {
    const { container } = render(<LiveRegion />);
    const region = container.querySelector('[aria-live="polite"]');
    if (!(region instanceof HTMLElement)) throw new Error("no live region");
    expect(region).toBeEmptyDOMElement();

    act(() => announce("Tâche ajoutée dans Globex"));
    const first = region.firstElementChild;
    expect(region).toHaveTextContent("Tâche ajoutée dans Globex");

    act(() => announce("Tâche ajoutée dans Globex"));
    // A new node, so screen readers read it again.
    expect(region.firstElementChild).not.toBe(first);
  });
});
