import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AvailableUpdate, configureUpdater, resetUpdater } from "../../lib/updater";
import { useUpdaterStore } from "../../stores/updater.store";
import { downloadPercent, formatBytes } from "./format";
import { UpdatesPanel } from "./UpdatesPanel";
import { UpdateToast } from "./UpdateToast";

const UPDATE: AvailableUpdate = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "Rappels plus compacts.",
  date: null,
};

beforeEach(() => {
  resetUpdater();
  useUpdaterStore.setState({
    status: { phase: "idle" },
    currentVersion: "0.1.0",
    supported: true,
    dismissedVersion: null,
  });
});

describe("format", () => {
  it("calcule un pourcentage borné, ou null si la taille est inconnue", () => {
    expect(downloadPercent(50, 200)).toBe(25);
    expect(downloadPercent(300, 200)).toBe(100);
    expect(downloadPercent(10, null)).toBeNull();
  });

  it("formate les tailles en Ko et Mo", () => {
    expect(formatBytes(2048)).toBe("2 Ko");
    expect(formatBytes(3.2 * 1024 * 1024)).toMatch(/^3,2\s?Mo$/);
  });
});

describe("UpdatesPanel (Réglages)", () => {
  it("hors de l'application installée : explication et bouton désactivé", () => {
    useUpdaterStore.setState({ supported: false });
    render(<UpdatesPanel />);
    expect(
      screen.getByText(/uniquement disponibles|que dans l'application installée/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechercher des mises à jour" })).toBeDisabled();
  });

  it("indique la version installée et vérifie à la demande", async () => {
    const user = userEvent.setup();
    const check = vi.fn(async () => null);
    configureUpdater({
      supported: true,
      currentVersion: async () => "0.1.0",
      check,
      installAndRestart: async () => undefined,
    });
    render(<UpdatesPanel />);
    expect(screen.getByText(/Version installée : 0\.1\.0/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rechercher des mises à jour" }));
    expect(check).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Dayali est à jour \(version 0\.1\.0\)/)).toBeInTheDocument();
  });

  it("propose d'installer une version disponible et affiche les notes", async () => {
    const user = userEvent.setup();
    const installAndRestart = vi.fn(async () => undefined);
    configureUpdater({
      supported: true,
      currentVersion: async () => "0.1.0",
      check: async () => UPDATE,
      installAndRestart,
    });
    useUpdaterStore.setState({ status: { phase: "available", update: UPDATE } });
    render(<UpdatesPanel />);

    expect(
      screen.getByText(/La version 0\.2\.0 est disponible \(vous avez la 0\.1\.0\)/),
    ).toBeInTheDocument();
    expect(screen.getByText("Notes de version 0.2.0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Installer et redémarrer" }));
    expect(installAndRestart).toHaveBeenCalledTimes(1);
  });

  it("affiche la progression pendant le téléchargement et bloque les boutons", () => {
    useUpdaterStore.setState({
      status: { phase: "downloading", update: UPDATE, downloaded: 50, total: 200 },
    });
    render(<UpdatesPanel />);
    expect(screen.getByText("Téléchargement de la version 0.2.0…")).toBeInTheDocument();
    expect(screen.getByText("25 %")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rechercher des mises à jour" })).toBeDisabled();
  });

  it("montre l'erreur d'installation et permet de réessayer", () => {
    useUpdaterStore.setState({
      status: { phase: "error", message: "L'installation a échoué : réseau", update: UPDATE },
    });
    render(<UpdatesPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent("L'installation a échoué : réseau");
    expect(screen.getByRole("button", { name: "Réessayer l'installation" })).toBeEnabled();
  });
});

describe("UpdateToast", () => {
  it("n'affiche rien tant qu'aucune mise à jour n'est connue", () => {
    const { container } = render(<UpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });

  it("annonce une nouvelle version, installable ou reportable", async () => {
    const user = userEvent.setup();
    const installAndRestart = vi.fn(async () => undefined);
    configureUpdater({
      supported: true,
      currentVersion: async () => "0.1.0",
      check: async () => UPDATE,
      installAndRestart,
    });
    useUpdaterStore.setState({ status: { phase: "available", update: UPDATE } });
    render(<UpdateToast />);

    expect(screen.getByText("Dayali 0.2.0 est disponible")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Installer et redémarrer" }));
    expect(installAndRestart).toHaveBeenCalledTimes(1);
  });

  it("« Plus tard » masque la notification pour cette version", async () => {
    const user = userEvent.setup();
    useUpdaterStore.setState({ status: { phase: "available", update: UPDATE } });
    render(<UpdateToast />);

    await user.click(screen.getByRole("button", { name: "Plus tard" }));
    expect(screen.queryByText("Dayali 0.2.0 est disponible")).not.toBeInTheDocument();
  });

  it("n'affiche pas une version déjà reportée, mais montre une version plus récente", () => {
    useUpdaterStore.setState({
      status: { phase: "available", update: UPDATE },
      dismissedVersion: "0.2.0",
    });
    const { rerender } = render(<UpdateToast />);
    expect(screen.queryByText("Dayali 0.2.0 est disponible")).not.toBeInTheDocument();

    useUpdaterStore.setState({
      status: { phase: "available", update: { ...UPDATE, version: "0.3.0" } },
    });
    rerender(<UpdateToast />);
    expect(screen.getByText("Dayali 0.3.0 est disponible")).toBeInTheDocument();
  });

  it("reste visible pendant le téléchargement et le redémarrage", () => {
    useUpdaterStore.setState({
      status: { phase: "downloading", update: UPDATE, downloaded: 10, total: 100 },
      dismissedVersion: "0.2.0",
    });
    const { rerender } = render(<UpdateToast />);
    expect(screen.getByText("Téléchargement de Dayali 0.2.0…")).toBeInTheDocument();

    useUpdaterStore.setState({ status: { phase: "restarting", update: UPDATE } });
    rerender(<UpdateToast />);
    expect(screen.getByText("Mise à jour installée, redémarrage…")).toBeInTheDocument();
  });

  it("signale un échec d'installation avec un bouton Réessayer", () => {
    useUpdaterStore.setState({
      status: { phase: "error", message: "L'installation a échoué : réseau", update: UPDATE },
    });
    render(<UpdateToast />);
    expect(screen.getByRole("alert")).toHaveTextContent("L'installation a échoué : réseau");
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });
});
