import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configureIpc, resetIpc } from "../../lib/ipc";
import { createMockIpc } from "../../lib/ipc/mock";
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
  beforeEach(() => {
    resetIpc();
    configureIpc(createMockIpc());
  });

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

  it("change de thème depuis la carte Apparence", async () => {
    const user = userEvent.setup();
    const onThemeChange = vi.fn();
    renderSettings({ theme: "auto", onThemeChange });

    expect(screen.getByRole("heading", { name: "Apparence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Automatique" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Sombre" }));
    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("change la couleur d'accent et marque l'accent courant", async () => {
    const user = userEvent.setup();
    const onAccentColorChange = vi.fn();
    renderSettings({ accentColor: "#c2703d", onAccentColorChange });

    expect(screen.getByRole("button", { name: "Cuivre" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Sauge" }));
    expect(onAccentColorChange).toHaveBeenCalledWith("#9fae7a");
  });

  it("propose les accents système dans leur propre groupe", () => {
    renderSettings({ accentColor: "#0a84ff" });

    expect(screen.getByText("Couleurs du système")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bleu" })).toHaveAttribute("aria-pressed", "true");
  });

  it("bascule vers la couleur du système et désactive les pastilles", async () => {
    const user = userEvent.setup();
    const onFollowSystemAccentChange = vi.fn();
    renderSettings({
      systemAccentColor: "#0a84ff",
      followSystemAccent: false,
      onFollowSystemAccentChange,
    });

    await user.click(screen.getByRole("checkbox", { name: "Suivre la couleur du système" }));
    expect(onFollowSystemAccentChange).toHaveBeenCalledWith(true);
  });

  it("désactive les pastilles quand le système pilote l'accent", () => {
    renderSettings({
      systemAccentColor: "#0a84ff",
      followSystemAccent: true,
      onAccentColorChange: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Braise" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Suivre la couleur du système" })).toBeChecked();
  });
});
