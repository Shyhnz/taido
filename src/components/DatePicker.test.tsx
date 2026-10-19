import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DatePicker, type DueValue } from "./DatePicker";

// Thursday 1 October 2026, 22:40 local time.
const NOW = new Date(2026, 9, 1, 22, 40);

function setup(value: DueValue = { date: null, time: null }) {
  const onChange = vi.fn();
  render(<DatePicker value={value} onChange={onChange} now={NOW} />);
  return { onChange, user: userEvent.setup() };
}

describe("DatePicker", () => {
  it("offers quick options in French", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("button", { name: /^Aujourd'hui/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-10-01",
      time: null,
    });
    await user.click(screen.getByRole("button", { name: /^Demain/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-10-02",
      time: null,
    });
    await user.click(screen.getByRole("button", { name: /^Lundi prochain/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-10-05",
      time: null,
    });
    // « Retirer » only exists when there is a date.
    expect(
      screen.queryByRole("button", { name: "Retirer l'échéance" }),
    ).toBeNull();
  });

  it("shows a Monday-first month grid and navigates months", async () => {
    const { onChange, user } = setup({ date: "2026-10-12", time: "09:00" });
    expect(screen.getByText("Octobre 2026")).toBeInTheDocument();
    const grid = screen.getByRole("group", { name: "Octobre 2026" });
    expect(within(grid).getByTitle("lundi")).toHaveTextContent("Lu");
    expect(grid.querySelector("abbr")).toHaveTextContent("Lu");
    const selected = within(grid).getByRole("button", {
      name: "lundi 12 octobre 2026",
    });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(
      within(grid).getByRole("button", {
        name: "jeudi 1 octobre 2026, aujourd'hui",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mois suivant" }));
    expect(screen.getByText("Novembre 2026")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "mardi 3 novembre 2026" }),
    );
    // The existing time is kept.
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-11-03",
      time: "09:00",
    });
  });

  it("moves between days with the arrow keys", async () => {
    const { onChange, user } = setup({ date: "2026-10-30", time: null });
    screen.getByRole("button", { name: "vendredi 30 octobre 2026" }).focus();
    await user.keyboard("{ArrowDown}");
    // Next week is in November: the grid follows.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "vendredi 6 novembre 2026" }),
      ).toHaveFocus(),
    );
    expect(screen.getByText("Novembre 2026")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "jeudi 5 novembre 2026" }),
      ).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-11-05",
      time: null,
    });
  });

  it("commits a typed time on Enter, today when there is no date", async () => {
    const { onChange, user } = setup();
    await user.type(screen.getByRole("textbox", { name: "Heure" }), "9:30");
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-10-01",
      time: "09:30",
    });
  });

  it("rejects a time it cannot read", async () => {
    const { onChange, user } = setup({ date: "2026-10-02", time: null });
    const field = screen.getByRole("textbox", { name: "Heure" });
    await user.type(field, "midi{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText("Heure non reconnue. Essaie 17h ou 9:30."),
    ).toBeInTheDocument();
  });

  it("uses the typed time when a day is clicked right after", async () => {
    const { onChange, user } = setup({ date: "2026-10-02", time: null });
    await user.type(screen.getByRole("textbox", { name: "Heure" }), "17h");
    await user.click(
      screen.getByRole("button", { name: "mercredi 7 octobre 2026" }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-10-07",
      time: "17:00",
    });
  });

  it("does not echo server values into the time field per keystroke (bug #1)", async () => {
    // A parent that saves every change and re-renders with the stored value.
    function Host() {
      const [value, setValue] = useState<DueValue>({
        date: "2026-10-02",
        time: null,
      });
      return <DatePicker value={value} onChange={setValue} now={NOW} />;
    }
    render(<Host />);
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Heure" });
    await user.type(field, "17h45");
    expect(field).toHaveValue("17h45");
    await user.keyboard("{Enter}");
    expect(field).toHaveValue("17:45");
  });

  it("removes the time or the whole due date", async () => {
    const { onChange, user } = setup({ date: "2026-10-02", time: "17:00" });
    await user.click(screen.getByRole("button", { name: "Retirer l'heure" }));
    expect(onChange).toHaveBeenLastCalledWith({
      date: "2026-10-02",
      time: null,
    });
    await user.click(
      screen.getByRole("button", { name: "Retirer l'échéance" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ date: null, time: null });
  });
});
