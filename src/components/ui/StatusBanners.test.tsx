import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusBanners } from "./StatusBanners";

function renderBanners(overrides: Partial<Parameters<typeof StatusBanners>[0]> = {}) {
  const props = {
    error: null,
    conflictCopy: null,
    reloading: false,
    onReloadConfig: vi.fn(),
    onDismissError: vi.fn(),
    ...overrides,
  };
  const utils = render(<StatusBanners {...props} />);
  return { ...utils, props };
}

describe("StatusBanners", () => {
  it("affiche une erreur de précondition avec l'action de rechargement", async () => {
    const user = userEvent.setup();
    const onReloadConfig = vi.fn();
    renderBanners({
      error: { code: "E_PRECONDITION_FAILED", message: "config.json", retryable: true },
      onReloadConfig,
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Le fichier a changé entre-temps");
    expect(alert).toHaveTextContent("Aucune écriture n'a été faite");
    await user.click(screen.getByRole("button", { name: "Recharger" }));
    expect(onReloadConfig).toHaveBeenCalledTimes(1);
  });

  it("ne permet pas de masquer une copie de conflit", () => {
    renderBanners({ conflictCopy: ".dayali/config.conflict-2e3f4a5b-20261026.json" });

    expect(screen.getByRole("status")).toHaveTextContent("Copie de conflit conservée");
    expect(screen.getByText(".dayali/config.conflict-2e3f4a5b-20261026.json")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fermer" })).not.toBeInTheDocument();
  });

  it("ne permet pas de fermer une erreur de conflit", () => {
    renderBanners({ error: { code: "E_CONFLICT", message: "lien en conflit", retryable: false } });
    expect(screen.getByRole("alert")).toHaveTextContent("Conflit détecté");
    expect(screen.queryByRole("button", { name: "Fermer" })).not.toBeInTheDocument();
  });

  it("signale un fuseau inconnu", () => {
    renderBanners({ timeZoneWarning: "Fuseau horaire inconnu « Mars/Base » : affichage en UTC." });
    expect(screen.getByText(/Fuseau horaire inconnu/)).toBeInTheDocument();
  });
});
