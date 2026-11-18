import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Reminder, ReminderList } from "../../lib/contracts/types";
import { configureIpc, resetIpc } from "../../lib/ipc";
import { IpcError } from "../../lib/ipc/errors";
import { createMockIpc, MOCK_MACHINE_ID } from "../../lib/ipc/mock";
import { resetAppStore, useAppStore } from "../../stores/app.store";
import { RemindersScreen } from "./RemindersScreen";

const NOW = new Date("2026-10-27T09:00:00.000Z");
const VAULT = "/Users/mock/Documents/Dayali";
const LOGICAL_DATE = "2026-10-27";

const LIST: ReminderList = {
  schemaVersion: 1,
  id: "list-todo",
  name: "À faire",
  color: null,
  order: 0,
  archived: false,
  createdAt: "2026-10-20T07:10:00.000Z",
  updatedAt: "2026-10-20T07:10:00.000Z",
  machineId: MOCK_MACHINE_ID,
};

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    schemaVersion: 1,
    id: "reminder-1",
    listId: LIST.id,
    title: "Payer la facture",
    notes: null,
    status: "open",
    dueDate: "2026-10-26",
    dueTime: null,
    dueTimeZone: null,
    projectId: null,
    completedAt: null,
    priority: null,
    recurrence: null,
    sortKey: null,
    createdAt: "2026-10-24T08:00:00.000Z",
    updatedAt: "2026-10-24T08:00:00.000Z",
    machineId: MOCK_MACHINE_ID,
    ...overrides,
  };
}

interface SeedOptions {
  items?: Reminder[];
  /** Données réellement renvoyées par l'IPC (état du store volontairement différent). */
  ipcItems?: Reminder[];
  lists?: ReminderList[];
  status?: "idle" | "loading" | "ready" | "error";
  error?: { code: "E_PRECONDITION_FAILED"; message: string; retryable: boolean } | null;
}

/** Installe l'IPC de test puis l'état du store attendu par l'écran. */
async function seed(options: SeedOptions = {}) {
  const items = options.items ?? [];
  const lists = options.lists ?? [LIST];
  const ipc = createMockIpc({
    timeZone: "Europe/Paris",
    now: () => NOW,
    moduleData: { reminders: options.ipcItems ?? items, lists },
  });
  configureIpc(ipc);
  // Hashes de la version affichée : l'écran ne les connaît pas, le store oui.
  const refs: Record<string, string> = {};
  await Promise.all(
    items.map(async (item) => {
      refs[item.id] = (await ipc.reminderFileRef({ id: item.id })).hash;
    }),
  );
  useAppStore.setState({
    vault: {
      root: VAULT,
      name: "Dayali",
      machineId: MOCK_MACHINE_ID,
      configRevision: "0".repeat(64),
    },
    reminders: {
      items,
      lists,
      refs,
      status: options.status ?? "ready",
      error: options.error ?? null,
    },
    remindersFilter: {},
  });
  return ipc;
}

function renderScreen() {
  return render(
    <RemindersScreen now={NOW} timeZone="Europe/Paris" locale="fr-FR" logicalDate={LOGICAL_DATE} />,
  );
}

beforeEach(() => {
  resetAppStore();
});

afterEach(() => {
  resetIpc();
});

describe("RemindersScreen", () => {
  it("rend les rappels et leurs métadonnées depuis le store", async () => {
    await seed({
      items: [
        makeReminder(),
        makeReminder({
          id: "reminder-2",
          title: "Appeler le dentiste",
          status: "done",
          dueDate: "2026-10-27",
          completedAt: "2026-10-27T08:15:00.000Z",
        }),
      ],
    });

    renderScreen();

    expect(screen.getByRole("heading", { level: 1, name: "Rappels" })).toBeInTheDocument();
    expect(screen.getByText("2 rappel(s) affiché(s)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Payer la facture" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appeler le dentiste" })).toBeInTheDocument();
    expect(screen.getByText("En retard")).toBeInTheDocument();
    expect(screen.getByText(/Échéance : lundi 26 octobre 2026/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Rouvrir « Appeler le dentiste »" })).toBeChecked();
    expect(screen.getByText("Terminé")).toBeInTheDocument();
  });

  it("affiche un état vide honnête sans inventer de rappel", async () => {
    await seed({ items: [] });

    renderScreen();

    expect(screen.getByText("0 rappel(s) affiché(s)")).toBeInTheDocument();
    expect(screen.getByText("Aucun rappel dans ce vault pour le moment.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("bascule un rappel ouvert vers terminé via saveReminder", async () => {
    const user = userEvent.setup();
    await seed({ items: [makeReminder()] });

    renderScreen();

    const checkbox = screen.getByRole("checkbox", {
      name: "Marquer « Payer la facture » comme terminé",
    });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    expect(
      await screen.findByRole("checkbox", { name: "Rouvrir « Payer la facture »" }),
    ).toBeChecked();
    expect(screen.getByText("Rappel terminé.")).toBeInTheDocument();
  });

  it("crée un rappel par saisie rapide et Entrée", async () => {
    const user = userEvent.setup();
    await seed({ items: [] });

    renderScreen();

    const quickInput = screen.getByLabelText("Titre du nouveau rappel");
    await user.type(quickInput, "Nouveau rappel{enter}");

    expect(screen.getByText("Rappel créé.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Nouveau rappel" })).toBeInTheDocument();
    expect(screen.getByText("1 rappel(s) affiché(s)")).toBeInTheDocument();
  });

  it("ouvre le panneau avancé (i) et modifie les propriétés du rappel", async () => {
    const user = userEvent.setup();
    await seed({ items: [makeReminder()] });

    renderScreen();

    const infoButton = screen.getByRole("button", {
      name: /Propriétés avancées de « Payer la facture »/,
    });
    await user.click(infoButton);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Propriétés avancées du rappel");

    const titleInput = screen.getByLabelText("Titre");
    await user.clear(titleInput);
    await user.type(titleInput, "Facture payée et validée");

    const prioritySelect = screen.getByLabelText("Priorité");
    await user.selectOptions(prioritySelect, "high");

    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(screen.getByText("Rappel modifié.")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Facture payée et validée" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Priorité haute")).toBeInTheDocument();
  });

  it("demande confirmation avant de supprimer puis retire la ligne", async () => {
    const user = userEvent.setup();
    await seed({ items: [makeReminder()] });

    renderScreen();

    await user.click(screen.getByRole("button", { name: "Supprimer" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Supprimer « Payer la facture » ?");
    expect(dialog).toHaveTextContent("déplacé dans la corbeille");

    await user.click(screen.getByRole("button", { name: "Confirmer la suppression" }));

    expect(screen.getByText("Rappel déplacé dans la corbeille.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Payer la facture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("signale E_PRECONDITION_FAILED et propose « Recharger »", async () => {
    const user = userEvent.setup();
    await seed({
      items: [],
      ipcItems: [makeReminder()],
      status: "error",
      error: {
        code: "E_PRECONDITION_FAILED",
        message: "Le fichier a changé entre-temps.",
        retryable: false,
      },
    });

    renderScreen();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("E_PRECONDITION_FAILED");
    expect(alert).toHaveTextContent("rien n'a été écrasé");
    const reload = screen.getByRole("button", { name: "Recharger" });
    expect(reload).toBeInTheDocument();

    await user.click(reload);

    expect(await screen.findByRole("heading", { name: "Payer la facture" })).toBeInTheDocument();
    expect(screen.queryByText("E_PRECONDITION_FAILED")).not.toBeInTheDocument();
  });

  it("affiche une erreur lisible quand la suppression échoue, sans retirer la ligne", async () => {
    const user = userEvent.setup();
    await seed({ items: [makeReminder()] });
    configureIpc({
      ...createMockIpc({
        timeZone: "Europe/Paris",
        now: () => NOW,
        moduleData: { reminders: [makeReminder()], lists: [LIST] },
      }),
      reminderDelete: async () => {
        throw new IpcError("E_PRECONDITION_FAILED");
      },
    });

    renderScreen();

    await user.click(screen.getByRole("button", { name: "Supprimer" }));
    await user.click(screen.getByRole("button", { name: "Confirmer la suppression" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("E_PRECONDITION_FAILED");
    expect(screen.getByRole("heading", { name: "Payer la facture" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recharger" })).toBeInTheDocument();
  });

  it("détecte un conflit à l'enregistrement et propose « Recharger »", async () => {
    const user = userEvent.setup();
    const loaded = makeReminder();
    const ipc = await seed({ items: [loaded] });
    const loadedRef = await ipc.reminderFileRef({ id: loaded.id });
    // Autre machine : le rappel change entre le chargement et l'enregistrement.
    await ipc.reminderSave({
      reminder: { ...loaded, title: "Modifié ailleurs" },
      expected: loadedRef.hash,
    });

    renderScreen();

    await user.click(screen.getByRole("button", { name: /Propriétés avancées/ }));
    const titleInput = screen.getByLabelText("Titre");
    await user.clear(titleInput);
    await user.type(titleInput, "Modifié ici");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("E_PRECONDITION_FAILED");
    expect(alert).toHaveTextContent("changé entre-temps");
    expect(alert).toHaveTextContent("rien n'a été écrasé");
    // L'écran montre toujours la version chargée, pas la version refusée.
    expect(screen.getByRole("heading", { name: "Payer la facture" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Modifié ici" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Recharger" }));

    expect(await screen.findByRole("heading", { name: "Modifié ailleurs" })).toBeInTheDocument();
    expect(screen.queryByText("E_PRECONDITION_FAILED")).not.toBeInTheDocument();
  });

  it("formate l'heure du rappel en heure locale pure sans suffixe UTC ou IANA", async () => {
    const user = userEvent.setup();
    await seed({
      items: [
        makeReminder({
          id: "r-time",
          title: "Rendez-vous important",
          dueDate: "2026-10-27",
          dueTime: "11:00",
          dueTimeZone: "Europe/Paris",
        }),
      ],
    });

    renderScreen();

    await user.click(screen.getByRole("button", { name: "Tous" }));

    expect(await screen.findByText("Rendez-vous important")).toBeInTheDocument();
    const dueElement = screen.getByText(/11:00/);
    expect(dueElement).toBeInTheDocument();
    expect(dueElement.textContent).not.toContain("UTC");
    expect(dueElement.textContent).not.toContain("Europe/Paris");
  });
});
