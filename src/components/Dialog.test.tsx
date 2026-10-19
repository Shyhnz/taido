import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DialogHost, promptDialog } from "./Dialog";

describe("promptDialog with submit", () => {
  it("keeps the dialog and the typed text when the command fails (audit B3)", async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const runCommand = vi
      .fn<(values: Record<string, string>) => Promise<unknown>>()
      .mockRejectedValueOnce({ kind: "invalid", message: "bad name" })
      .mockResolvedValueOnce(null);
    render(<DialogHost />);
    const result = promptDialog({
      title: "Renommer la section",
      fields: [{ name: "name", label: "Nom", initial: "", required: true }],
      submit: { run: runCommand, action: "Impossible de modifier la section." },
    });
    const field = await screen.findByLabelText("Nom");
    await user.type(field, "Design{Enter}");
    expect(
      await screen.findByText(
        "Impossible de modifier la section. Vérifie la saisie.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Nom")).toHaveValue("Design");
    expect(screen.getByLabelText("Nom")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Enregistrer" }));
    await expect(result).resolves.toEqual({ name: "Design" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(runCommand).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
