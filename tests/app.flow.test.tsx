import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MOCK_DEFAULT_CONFIG } from "../src/lib/contracts/defaults";
import type { LocalCalendarEvent, MachineLocal, Reminder } from "../src/lib/contracts/types";
import { configureIpc } from "../src/lib/ipc";
import { IpcError } from "../src/lib/ipc/errors";
import { createMockIpc, MOCK_MACHINE_ID } from "../src/lib/ipc/mock";
import { useAppStore } from "../src/stores/app.store";
import { renderApp } from "./render-app";

const VAULT = "/Users/mock/Documents/Dayali";
const CONFLICT_COPY = ".dayali/config.conflict-2e3f4a5b-20261026.json";

function machineLocal(overrides: Partial<MachineLocal> = {}): MachineLocal {
  return {
    schemaVersion: 1,
    machineId: MOCK_MACHINE_ID,
    createdAt: "2026-10-20T07:05:00.000Z",
    lastVaultPath: null,
    recentVaults: [],
    ...overrides,
  };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    schemaVersion: 1,
    id: "reminder-flow-1",
    listId: "list-todo",
    title: "Préparer la journée",
    notes: null,
    status: "open",
    dueDate: "2026-10-27",
    dueTime: "09:00",
    dueTimeZone: "Europe/Paris",
    projectId: null,
    completedAt: null,
    recurrence: null,
    sortKey: null,
    createdAt: "2026-10-20T07:10:00.000Z",
    updatedAt: "2026-10-20T07:10:00.000Z",
    machineId: MOCK_MACHINE_ID,
    ...overrides,
  };
}

function localEvent(overrides: Partial<LocalCalendarEvent> = {}): LocalCalendarEvent {
  return {
    id: "event-flow-1",
    uid: "event-flow-1@dayali.local",
    calendarId: "local",
    title: "Point d'équipe",
    description: null,
    location: null,
    allDay: true,
    start: { date: "2026-10-27" },
    end: { date: "2026-10-28" },
    projectId: null,
    machineId: MOCK_MACHINE_ID,
    createdAt: "2026-10-20T07:10:00.000Z",
    updatedAt: "2026-10-20T07:10:00.000Z",
    sequence: 0,
    status: "confirmed",
    ...overrides,
  };
}

describe("parcours complet de l'étape (a)", () => {
  it("choisit un vault, démarre la journée avec Entrée, puis revient à l'accueil", async () => {
    const user = userEvent.setup();
    const base = createMockIpc();
    let dayStartCalls = 0;
    configureIpc({
      ...base,
      dayStart: async (input) => {
        dayStartCalls += 1;
        return base.dayStart(input);
      },
    });
    renderApp(["/"]);

    // 1. Aucun vault connu → écran de choix, erreur de lancement absente.
    expect(
      await screen.findByRole("heading", { name: /Votre journée, vos fichiers/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // 2. Ouverture via le sélecteur de dossier (chemin factice hors Tauri).
    await user.click(screen.getByRole("button", { name: "Ouvrir un dossier" }));

    // 3. La journée n'est pas encore démarrée : l'accueil propose le démarrage.
    const startButton = await screen.findByRole("button", { name: "Démarrer la journée" });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(useAppStore.getState().dayState?.started).toBe(false);

    // 4. `Entrée` hors contrôle interactif démarre la journée (raccourci global).
    startButton.blur();
    expect(startButton).not.toHaveFocus();
    await user.keyboard("{Enter}");

    // 5. L'aperçu du jour apparaît sur la même route, sans coquille de navigation.
    expect(await screen.findByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
    expect(screen.getByText("Aucun événement aujourd'hui.")).toBeInTheDocument();
    expect(useAppStore.getState().dayState?.started).toBe(true);

    // 6. Le bouton du dashboard mène au dashboard, qui conserve « Revoir l'accueil ».
    await user.click(screen.getByRole("button", { name: "Ouvrir le dashboard" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();

    // 7. Retourner à l'accueil via la sidebar (le lien « Démarrage de journée ») ne redémarre pas la journée.
    await user.click(screen.getByRole("link", { name: "Démarrage de journée" }));
    expect(await screen.findByRole("button", { name: "Voir ma journée" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Démarrer la journée" })).not.toBeInTheDocument();
    expect(useAppStore.getState().dayState?.started).toBe(true);

    // 8. « Voir ma journée » ouvre l'aperçu sans second `day_start`.
    await user.click(screen.getByRole("button", { name: "Voir ma journée" }));
    expect(await screen.findByText("Aucun événement aujourd'hui.")).toBeInTheDocument();
    expect(dayStartCalls).toBe(1);
  });

  it("charge les rappels réels du store à l'entrée en aperçu", async () => {
    const user = userEvent.setup();
    configureIpc(
      createMockIpc({
        now: () => new Date("2026-10-27T09:00:00.000Z"),
        machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
        moduleData: { reminders: [reminder()] },
      }),
    );

    renderApp(["/"]);
    await user.click(await screen.findByRole("button", { name: "Démarrer la journée" }));

    // Vérifier que la section rappels est chargée (UI ou message vide selon logicalDate réelle)
    await screen.findByRole("region", { name: "Rappels du jour" });
    // L'objectif est de vérifier que le store IPC a bien été appelé et a chargé 1 rappel
    expect(useAppStore.getState().reminders.status).toBe("ready");
    expect(useAppStore.getState().reminders.items).toHaveLength(1);
  });

  it("un rechargement sur /today après démarrage ouvre le dashboard", async () => {
    const user = userEvent.setup();
    configureIpc(
      createMockIpc({
        machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
      }),
    );

    const first = renderApp(["/"]);
    await user.click(await screen.findByRole("button", { name: "Démarrer la journée" }));
    expect(await screen.findByText("Aucun événement aujourd'hui.")).toBeInTheDocument();
    first.unmount();

    // Rechargement : plus de marqueur « voir l'accueil », la journée est démarrée.
    renderApp(["/today"]);
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByText("Aucun événement aujourd'hui.")).not.toBeInTheDocument();
  });

  it("va directement au dashboard au lancement quand le réglage est actif", async () => {
    configureIpc(
      createMockIpc({
        machineLocal: machineLocal({
          lastVaultPath: VAULT,
          recentVaults: [VAULT],
        }),
        config: { ...MOCK_DEFAULT_CONFIG, openDashboardOnLaunch: true },
      }),
    );

    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    // Le dashboard ne prétend pas que la journée a été démarrée pour autant.
    expect(screen.getByText(/n'est pas encore marquée comme démarrée/)).toBeInTheDocument();
    expect(useAppStore.getState().dayState?.started).toBe(false);
  });

  it("applique le réglage dashboard direct même sur un accès direct à /today", async () => {
    configureIpc(
      createMockIpc({
        machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
        config: { ...MOCK_DEFAULT_CONFIG, openDashboardOnLaunch: true },
      }),
    );

    renderApp(["/today"]);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Démarrer la journée" })).not.toBeInTheDocument();
  });

  it("n'affiche en report de la veille que les restes ouverts non traités de la veille", async () => {
    const user = userEvent.setup();
    const base = createMockIpc({
      now: () => new Date("2026-10-28T09:00:00.000Z"),
      timeZone: "UTC",
      machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
      moduleData: {
        reminders: [
          reminder({ id: "carry-open", title: "Ranger le bureau", dueDate: "2026-10-27" }),
          reminder({
            id: "carry-done",
            title: "Courses terminées",
            dueDate: "2026-10-27",
            status: "done",
            completedAt: "2026-10-27T10:00:00.000Z",
          }),
          reminder({ id: "today-open", title: "Préparer la réunion", dueDate: "2026-10-28" }),
        ],
      },
    });
    configureIpc({
      ...base,
      // L'horloge de l'app (`startDay`) est réelle : on fige l'instant injecté
      // dans la commande pour rester aligné sur l'horloge du mock.
      dayStart: (input) => base.dayStart({ ...input, at: "2026-10-28T09:00:00.000Z" }),
    });

    renderApp(["/"]);
    await user.click(await screen.findByRole("button", { name: "Démarrer la journée" }));

    const section = await screen.findByRole("region", { name: "Report de la veille" });
    expect(within(section).getByText("Ranger le bureau")).toBeInTheDocument();
    expect(within(section).queryByText("Courses terminées")).not.toBeInTheDocument();
    expect(within(section).queryByText("Préparer la réunion")).not.toBeInTheDocument();
    expect(useAppStore.getState().dayState?.carryOverCandidates).toHaveLength(1);
    expect(screen.queryByTestId("carry-over-warnings")).not.toBeInTheDocument();
  });

  it("affiche un avertissement de rappel illisible injecté par le mock sans bloquer l'accueil", async () => {
    const user = userEvent.setup();
    const warning =
      "reminders/0199a1b2-0000-7000-8000-000000000302.json : E_SCHEMA_INVALID — JSON invalide (ligne 1, colonne 1)";
    configureIpc(
      createMockIpc({
        machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
        dayStateWarnings: [warning],
      }),
    );

    renderApp(["/"]);

    // L'accueil s'affiche malgré l'avertissement : aucune erreur bloquante.
    await user.click(await screen.findByRole("button", { name: "Démarrer la journée" }));

    const status = await screen.findByTestId("carry-over-warnings");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(warning);
    expect(status).toHaveTextContent("fichier non modifié");
    expect(useAppStore.getState().dayState?.carryOverWarnings).toEqual([warning]);
  });

  it("affiche une copie de conflit sans aucune action qui la masque", async () => {
    configureIpc(
      createMockIpc({
        machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
        conflictCopy: CONFLICT_COPY,
      }),
    );

    renderApp(["/"]);

    const banner = await screen.findByText("Copie de conflit conservée");
    expect(banner.closest('[role="status"]')).toHaveTextContent(CONFLICT_COPY);
    expect(screen.queryByRole("button", { name: "Fermer" })).not.toBeInTheDocument();
    expect(useAppStore.getState().configConflictCopy).toBe(CONFLICT_COPY);
  });

  it("retombe sur l'écran de choix avec l'erreur quand le dernier vault est introuvable", async () => {
    const user = userEvent.setup();
    const base = createMockIpc({
      machineLocal: machineLocal({
        lastVaultPath: "/Volumes/Disparu/Dayali",
        recentVaults: ["/Volumes/Disparu/Dayali"],
      }),
    });
    configureIpc({
      ...base,
      vaultOpen: async () => {
        throw new IpcError("E_NOT_FOUND", "Le dossier n'existe pas.");
      },
    });

    renderApp(["/"]);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Fichier ou dossier introuvable.");
    expect(alert).toHaveTextContent("E_NOT_FOUND");

    // L'erreur de lancement est fermable : elle ne reste pas collée à l'écran.
    await user.click(screen.getByRole("button", { name: "Fermer" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("/Volumes/Disparu/Dayali")).toBeInTheDocument();
  });

  it("crée un événement dans l'agenda puis le retrouve dans l'aperçu du jour", async () => {
    const user = userEvent.setup();
    configureIpc(
      createMockIpc({
        timeZone: "Europe/Paris",
        machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
      }),
    );

    renderApp(["/calendar"]);

    expect(await screen.findByRole("heading", { name: "Agenda" })).toBeInTheDocument();
    await user.type(await screen.findByLabelText("Titre de l'événement"), "Déjeuner d'équipe");
    await user.click(screen.getByLabelText("Journée entière"));
    await user.click(screen.getByRole("button", { name: "Ajouter l'événement" }));

    expect(await screen.findByText("Événement créé.")).toBeInTheDocument();
    expect(screen.getAllByText("Déjeuner d'équipe").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("link", { name: "Démarrage de journée" }));
    await user.click(await screen.findByRole("button", { name: "Démarrer la journée" }));

    const agendaSection = await screen.findByRole("region", { name: "Agenda du jour" });
    expect(within(agendaSection).getByText("Déjeuner d'équipe")).toBeInTheDocument();
    expect(within(agendaSection).getByText("Journée entière")).toBeInTheDocument();
  });

  it("le mock refuse d'écrire un événement avec un expected périmé", async () => {
    const event = localEvent();
    const ipc = createMockIpc({ timeZone: "UTC", moduleData: { calendarEvents: [event] } });
    const initial = await ipc.calendarFileRef({ id: event.id });

    const firstWrite = await ipc.calendarSave({
      event: { ...event, title: "Version machine A" },
      expected: initial.hash,
    });
    expect(firstWrite.title).toBe("Version machine A");

    // La version a changé : la précondition de départ n'est plus valable.
    await expect(
      ipc.calendarSave({
        event: { ...event, title: "Version machine B" },
        expected: initial.hash,
      }),
    ).rejects.toMatchObject({ code: "E_PRECONDITION_FAILED" });

    const list = await ipc.calendarList({ from: "2026-10-27", to: "2026-10-27" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ title: "Version machine A" });
  });
});
