import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DirectoryPicker } from "../../lib/ipc/dialog";
import { VaultSetupScreen } from "./VaultSetupScreen";

const DOCS = "/Users/mock/Documents";
const TRAVAIL = "/Users/mock/Documents/Travail";
const RECENT_A = "/Users/tiago/Documents/Dayali";
const RECENT_B = "/Volumes/Partage/Dayali";

function renderScreen(overrides: Partial<ComponentProps<typeof VaultSetupScreen>> = {}) {
  const props: ComponentProps<typeof VaultSetupScreen> = {
    recentVaults: [],
    lastVaultPath: null,
    busy: false,
    error: null,
    errorCode: null,
    errorDetails: null,
    pickDirectory: vi.fn<DirectoryPicker>(async () => null),
    onOpenVault: vi.fn(),
    onCreateVault: vi.fn(),
    onDismissError: vi.fn(),
    ...overrides,
  };
  return { ...render(<VaultSetupScreen {...props} />), props };
}

describe("VaultSetupScreen", () => {
  it("affiche les vaults récents et marque le dernier ouvert sur l'écran d'accueil", () => {
    renderScreen({
      recentVaults: [RECENT_A, RECENT_B],
      lastVaultPath: RECENT_A,
    });

    expect(screen.getByRole("heading", { name: /Votre journée/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Vaults récents" })).toBeInTheDocument();
    expect(screen.getByText(RECENT_A)).toBeInTheDocument();
    expect(screen.getByText(RECENT_B)).toBeInTheDocument();

    const badge = screen.getByText("Dernier ouvert");
    expect(badge.closest("li")).toHaveTextContent(RECENT_A);
    expect(badge.closest("li")).not.toHaveTextContent(RECENT_B);
  });

  it("ouvre un vault récent au clic", async () => {
    const user = userEvent.setup();
    const onOpenVault = vi.fn();
    renderScreen({
      recentVaults: [RECENT_A, RECENT_B],
      lastVaultPath: RECENT_A,
      onOpenVault,
    });

    await user.click(screen.getByRole("button", { name: /\/Volumes\/Partage\/Dayali/ }));

    expect(onOpenVault).toHaveBeenCalledTimes(1);
    expect(onOpenVault).toHaveBeenCalledWith(RECENT_B);
  });

  it("« Ouvrir un dossier » passe par le sélecteur purpose « vault »", async () => {
    const user = userEvent.setup();
    const onOpenVault = vi.fn();
    const pickDirectory = vi.fn<DirectoryPicker>(async () => "/tmp/nouveau-vault");
    renderScreen({ onOpenVault, pickDirectory });

    await user.click(screen.getByRole("button", { name: "Ouvrir un dossier" }));

    expect(pickDirectory).toHaveBeenCalledWith(expect.objectContaining({ purpose: "vault" }));
    expect(onOpenVault).toHaveBeenCalledWith("/tmp/nouveau-vault");
  });

  it("crée un vault via le tunnel progressif en étapes (nom, emplacement, confirmation)", async () => {
    const user = userEvent.setup();
    const onCreateVault = vi.fn();
    const pickDirectory = vi.fn<DirectoryPicker>(async () => DOCS);
    renderScreen({ onCreateVault, pickDirectory });

    // Démarrer le tunnel de création
    await user.click(screen.getByRole("button", { name: "Créer un nouveau vault" }));
    expect(screen.getByRole("heading", { name: /1\. Donnez un nom/ })).toBeInTheDocument();

    // Étape 1 : Saisir le nom
    await user.type(screen.getByLabelText("Nom du vault"), "Travail");
    await user.click(screen.getByRole("button", { name: "Suivant" }));

    // Étape 2 : Choisir l'emplacement
    const pickParentBtn = await screen.findByRole("button", { name: "Choisir un dossier parent" });
    expect(
      screen.getByRole("heading", { name: /2\. Choisissez l'emplacement/ }),
    ).toBeInTheDocument();
    await user.click(pickParentBtn);
    expect(pickDirectory).toHaveBeenCalledWith(expect.objectContaining({ purpose: "parent" }));
    await screen.findByText(DOCS);
    await user.click(screen.getByRole("button", { name: "Suivant" }));

    // Étape 3 : Confirmation
    expect(await screen.findByRole("heading", { name: /3\. Confirmation/ })).toBeInTheDocument();
    expect(screen.getByText(TRAVAIL)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Créer le vault" }));

    expect(onCreateVault).toHaveBeenCalledTimes(1);
    expect(onCreateVault).toHaveBeenCalledWith(DOCS, "Travail");
  });

  it("refuse d'avancer sans dossier parent à l'étape 2", async () => {
    const user = userEvent.setup();
    const onCreateVault = vi.fn();
    renderScreen({ onCreateVault });

    await user.click(screen.getByRole("button", { name: "Créer un nouveau vault" }));
    await user.type(screen.getByLabelText("Nom du vault"), "Travail");
    await user.click(screen.getByRole("button", { name: "Suivant" }));

    // À l'étape 2, sans choisir de parent, cliquer sur Suivant
    const nextBtn = await screen.findByRole("button", { name: "Suivant" });
    await user.click(nextBtn);

    expect(onCreateVault).not.toHaveBeenCalled();
    expect(screen.getByText("Choisissez d'abord le dossier parent du vault.")).toBeInTheDocument();
  });

  it.each([
    ["", /Donnez un nom au vault/],
    ["a/b", /ne peut pas contenir/],
    ["Travail.", /se terminer par un point/],
    ["CON", /réservé par Windows/],
  ])("refuse le nom invalide %j à l'étape 1", async (name, message) => {
    const user = userEvent.setup();
    const onCreateVault = vi.fn();
    renderScreen({ onCreateVault });

    await user.click(screen.getByRole("button", { name: "Créer un nouveau vault" }));
    const input = screen.getByLabelText("Nom du vault");
    if (name) await user.type(input, name);
    else await user.clear(input);

    await user.click(screen.getByRole("button", { name: "Suivant" }));

    expect(onCreateVault).not.toHaveBeenCalled();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("propose d'ouvrir <parent>/<nom> quand le dossier existe déjà et n'est pas vide", async () => {
    const user = userEvent.setup();
    const onOpenVault = vi.fn();
    const { rerender, props } = renderScreen({
      pickDirectory: vi.fn<DirectoryPicker>(async () => DOCS),
      onOpenVault,
    });

    await user.click(screen.getByRole("button", { name: "Créer un nouveau vault" }));
    await user.type(screen.getByLabelText("Nom du vault"), "Travail");
    await user.click(screen.getByRole("button", { name: "Suivant" }));
    const pickParentBtn = await screen.findByRole("button", { name: "Choisir un dossier parent" });
    await user.click(pickParentBtn);
    await screen.findByText(DOCS);
    await user.click(screen.getByRole("button", { name: "Suivant" }));
    await screen.findByRole("heading", { name: /3\. Confirmation/ });
    await user.click(screen.getByRole("button", { name: "Créer le vault" }));
    expect(props.onCreateVault).toHaveBeenCalledWith(DOCS, "Travail");

    rerender(
      <VaultSetupScreen
        {...props}
        error="Le dossier existe déjà et n'est pas vide."
        errorCode="E_PRECONDITION_FAILED"
        errorDetails={{ reason: "not_empty" }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(screen.getByText(/Aucune donnée n'a été écrasée/)).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Ouvrir ce dossier" }));

    expect(onOpenVault).toHaveBeenCalledTimes(1);
    expect(onOpenVault).toHaveBeenCalledWith(TRAVAIL);
  });

  it("ferme l'alerte d'erreur avec le bouton « Fermer »", async () => {
    const user = userEvent.setup();
    const onDismissError = vi.fn();
    renderScreen({
      error: "Le dossier du dernier vault est introuvable.",
      errorCode: "E_NOT_FOUND",
      onDismissError,
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Le dossier du dernier vault est introuvable.");
    expect(alert).toHaveTextContent("E_NOT_FOUND");

    await user.click(screen.getByRole("button", { name: "Fermer" }));

    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it("expose aria-busy et désactive les actions pendant une opération", () => {
    renderScreen({ busy: true, recentVaults: [RECENT_A], lastVaultPath: RECENT_A });

    expect(screen.getByRole("button", { name: "Créer un nouveau vault" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ouvrir un dossier" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Dayali/ })).toBeDisabled();
  });
});
