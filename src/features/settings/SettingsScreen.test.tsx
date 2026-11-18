import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "./SettingsScreen";

function renderSettings(overrides: Partial<Parameters<typeof SettingsScreen>[0]> = {}) {
  const props = {
    vaultName: "Mon Vault",
    vaultPath: "/Users/test/vaults/mon-vault",
    openDashboardOnLaunch: false,
    busy: false,
    onOpenDashboardOnLaunchChange: vi.fn(),
    onOpenVaultChooser: vi.fn(),
    version: "0.1.0",
    ...overrides,
  };
  const utils = render(<SettingsScreen {...props} />);
  return { ...utils, props };
}

describe("SettingsScreen", () => {
  it("affiche le titre, le vault actuel, les réglages et les crédits", () => {
    renderSettings();

    expect(screen.getByRole("heading", { name: "Réglages" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vault actuel" })).toBeInTheDocument();
    expect(screen.getByText("Mon Vault")).toBeInTheDocument();
    expect(screen.getByText("/Users/test/vaults/mon-vault")).toBeInTheDocument();

    expect(
      screen.getByRole("heading", { name: "Préférences de l'application" }),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("checkbox", { name: "Ouvrir directement le dashboard" });
    expect(toggle).toBeInTheDocument();
    expect(toggle).not.toBeChecked();

    expect(screen.getByRole("heading", { name: "Informations et crédits" })).toBeInTheDocument();
    expect(screen.getByText(/Dayali — Version 0.1.0/)).toBeInTheDocument();
    const credits = screen.getByTestId("settings-credits");
    expect(credits).toBeInTheDocument();
    expect(credits).toHaveTextContent("Police Lora");
    expect(credits).toHaveTextContent("Salvatore Gerace");
  });

  it("déclenche le changement de vault lors du clic sur le bouton", async () => {
    const user = userEvent.setup();
    const onOpenVaultChooser = vi.fn();
    renderSettings({ onOpenVaultChooser });

    await user.click(screen.getByRole("button", { name: "Changer de vault" }));
    expect(onOpenVaultChooser).toHaveBeenCalledTimes(1);
  });

  it("reflète et modifie le réglage openDashboardOnLaunch", async () => {
    const user = userEvent.setup();
    const onOpenDashboardOnLaunchChange = vi.fn();
    renderSettings({ onOpenDashboardOnLaunchChange, openDashboardOnLaunch: false });

    const toggle = screen.getByRole("checkbox", { name: "Ouvrir directement le dashboard" });
    await user.click(toggle);
    expect(onOpenDashboardOnLaunchChange).toHaveBeenCalledWith(true);
  });

  it("affiche le réglage coché si openDashboardOnLaunch est vrai", () => {
    renderSettings({ openDashboardOnLaunch: true });
    expect(screen.getByRole("checkbox", { name: "Ouvrir directement le dashboard" })).toBeChecked();
  });
});
