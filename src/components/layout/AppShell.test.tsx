import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

function renderAppShell(overrides: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const props = {
    vaultName: "Mon Super Vault",
    onOpenVaultChooser: vi.fn(),
    children: <div data-testid="child-content">Contenu principal</div>,
    ...overrides,
  };

  const utils = render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <AppShell {...props} />
    </MemoryRouter>,
  );

  return { ...utils, props };
}

describe("AppShell (Sidebar)", () => {
  it("affiche la sidebar avec le nom du vault et les liens de navigation (Dashboard, Agenda, Rappels, Accueil, Fin de journée, Réglages)", () => {
    renderAppShell();

    expect(screen.getByText("Mon Super Vault")).toBeInTheDocument();
    expect(screen.getByTestId("child-content")).toBeInTheDocument();

    // Liens de navigation
    expect(screen.getByRole("link", { name: /démarrage de journée/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /agenda/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /rappels/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /fin de journée/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /réglages/i })).toBeInTheDocument();
  });

  it("déclenche l'action de changement de vault", async () => {
    const user = userEvent.setup();
    const onOpenVaultChooser = vi.fn();
    renderAppShell({ onOpenVaultChooser });

    const changeButton = screen.getByRole("button", { name: /changer de vault/i });
    await user.click(changeButton);
    expect(onOpenVaultChooser).toHaveBeenCalledTimes(1);
  });

  it("affiche les bandeaux si fournis", () => {
    renderAppShell({ banners: <div data-testid="banner">Bandeau test</div> });
    expect(screen.getByTestId("banner")).toBeInTheDocument();
  });
});
