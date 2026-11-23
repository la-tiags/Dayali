import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_DEFAULT_CONFIG } from "../../lib/contracts/defaults";
import type { LocalCalendarEvent } from "../../lib/contracts/types";
import { configureIpc } from "../../lib/ipc";
import { createMockIpc, MOCK_MACHINE_ID } from "../../lib/ipc/mock";
import { resetAppStore, useAppStore } from "../../stores/app.store";
import { CalendarScreen } from "./CalendarScreen";

const NOW = new Date("2026-10-27T09:00:00.000Z");
const PARIS = "Europe/Paris";
const VAULT = "/Users/mock/Documents/Dayali";

function event(overrides: Partial<LocalCalendarEvent> = {}): LocalCalendarEvent {
  return {
    id: "event-1",
    uid: "event-1@dayali.local",
    calendarId: "local",
    title: "Réunion",
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

function setup(events: readonly LocalCalendarEvent[] = [], warnings: readonly string[] = []) {
  const base = createMockIpc({
    now: () => NOW,
    timeZone: PARIS,
    moduleData: { calendarEvents: events, calendarWarnings: warnings },
  });
  configureIpc(base);
  useAppStore.setState({
    vault: {
      root: VAULT,
      name: "Dayali",
      machineId: MOCK_MACHINE_ID,
      configRevision: "0".repeat(64),
    },
    config: MOCK_DEFAULT_CONFIG,
    dayState: null,
  });
  return base;
}

function renderScreen() {
  return render(
    <CalendarScreen now={NOW} timeZone={PARIS} locale="fr-FR" logicalDate="2026-10-27" />,
  );
}

beforeEach(() => {
  resetAppStore();
});

describe("CalendarScreen — création", () => {
  it("ouvre la création dans une boîte de dialogue et la referme", async () => {
    const user = userEvent.setup();
    setup();
    renderScreen();

    await screen.findByText("Aucun événement du jour ni dans les 30 jours suivants.");
    const dialog = screen.getByTestId("calendar-event-dialog");
    expect(dialog).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Nouvel événement" }));
    await waitFor(() => expect(dialog).toHaveAttribute("open"));
    expect(screen.getByRole("dialog", { name: "Nouvel événement" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Fermer" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });

  it("crée un événement journée entière avec des dates locales", async () => {
    const user = userEvent.setup();
    const base = setup();
    const save = vi.fn(base.calendarSave);
    configureIpc({ ...base, calendarSave: save });
    renderScreen();

    expect(
      await screen.findByText("Aucun événement du jour ni dans les 30 jours suivants."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nouvel événement" }));
    await user.type(screen.getByLabelText("Titre de l'événement"), "Anniversaire");
    await user.click(screen.getByLabelText("Journée entière"));
    fireEvent.change(screen.getByLabelText("Début"), {
      target: { value: "2026-11-02" },
    });
    fireEvent.change(screen.getByLabelText("Fin (exclue)"), {
      target: { value: "2026-11-03" },
    });
    await user.click(screen.getByRole("button", { name: "Ajouter l'événement" }));

    expect(await screen.findByText("Événement créé.")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-dialog")).not.toHaveAttribute("open");
    expect(save).toHaveBeenCalledTimes(1);
    const input = save.mock.calls[0]?.[0];
    expect(input?.expected).toBeUndefined();
    expect(input?.event).toMatchObject({
      id: "",
      title: "Anniversaire",
      allDay: true,
      start: { date: "2026-11-02" },
      end: { date: "2026-11-03" },
    });
    expect(await screen.findByText("Anniversaire")).toBeInTheDocument();
    await waitFor(() => {
      const created = useAppStore
        .getState()
        .agenda.items.find((item) => item.title === "Anniversaire");
      const ref =
        created && "id" in created ? useAppStore.getState().agenda.refs[created.id] : null;
      expect(ref).toBeDefined();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("crée un événement horaire en convertissant l'heure locale en UTC", async () => {
    const user = userEvent.setup();
    const base = setup();
    const save = vi.fn(base.calendarSave);
    configureIpc({ ...base, calendarSave: save });
    renderScreen();

    await screen.findByText("Aucun événement du jour ni dans les 30 jours suivants.");
    await user.click(screen.getByRole("button", { name: "Nouvel événement" }));
    await user.type(screen.getByLabelText("Titre de l'événement"), "Point projet");
    fireEvent.change(screen.getByLabelText("Début"), {
      target: { value: "2026-10-27T14:00" },
    });
    fireEvent.change(screen.getByLabelText("Fin"), {
      target: { value: "2026-10-27T15:30" },
    });
    await user.click(screen.getByRole("button", { name: "Ajouter l'événement" }));

    expect(await screen.findByText("Événement créé.")).toBeInTheDocument();
    const input = save.mock.calls[0]?.[0];
    expect(input?.event).toMatchObject({
      title: "Point projet",
      allDay: false,
      start: { dateTime: "2026-10-27T13:00:00.000Z", timeZone: PARIS },
      end: { dateTime: "2026-10-27T14:30:00.000Z", timeZone: PARIS },
    });
  });

  it("refuse une fin antérieure au début sans appeler le vault", async () => {
    const user = userEvent.setup();
    const base = setup();
    const save = vi.fn(base.calendarSave);
    configureIpc({ ...base, calendarSave: save });
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Nouvel événement" }));
    await user.type(screen.getByLabelText("Titre de l'événement"), "Invalide");
    fireEvent.change(screen.getByLabelText("Début"), {
      target: { value: "2026-10-27T15:00" },
    });
    fireEvent.change(screen.getByLabelText("Fin"), {
      target: { value: "2026-10-27T14:00" },
    });
    await user.click(screen.getByRole("button", { name: "Ajouter l'événement" }));

    expect(await screen.findByText("La fin doit être postérieure au début.")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("crée un événement hors de la fenêtre affichée sans faux conflit", async () => {
    const user = userEvent.setup();
    const base = setup();
    const save = vi.fn(base.calendarSave);
    configureIpc({ ...base, calendarSave: save });
    renderScreen();

    await screen.findByText("Aucun événement du jour ni dans les 30 jours suivants.");
    await user.click(screen.getByRole("button", { name: "Nouvel événement" }));
    await user.type(screen.getByLabelText("Titre de l'événement"), "Congrès de juin");
    await user.click(screen.getByLabelText("Journée entière"));
    fireEvent.change(screen.getByLabelText("Début"), {
      target: { value: "2027-06-01" },
    });
    fireEvent.change(screen.getByLabelText("Fin (exclue)"), {
      target: { value: "2027-06-02" },
    });
    await user.click(screen.getByRole("button", { name: "Ajouter l'événement" }));

    expect(await screen.findByText("Événement créé.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => {
      const created = useAppStore
        .getState()
        .agenda.items.find((item) => item.title === "Congrès de juin");
      const ref =
        created && "id" in created ? useAppStore.getState().agenda.refs[created.id] : null;
      expect(ref).toBeDefined();
    });
  });
});

describe("CalendarScreen — édition et suppression", () => {
  it("modifie un événement prérempli avec le hash chargé", async () => {
    const user = userEvent.setup();
    const existing = event();
    const base = setup([existing]);
    const save = vi.fn(base.calendarSave);
    configureIpc({ ...base, calendarSave: save });
    renderScreen();

    expect(await screen.findByText("Réunion")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().agenda.refs[existing.id]).toBeDefined());
    const expected = useAppStore.getState().agenda.refs[existing.id];

    await user.click(screen.getByRole("button", { name: "Modifier « Réunion »" }));
    const titleInput = screen.getByLabelText("Titre de l'événement");
    expect(titleInput).toHaveValue("Réunion");
    await user.clear(titleInput);
    await user.type(titleInput, "Réunion modifiée");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("Événement modifié.")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      expected,
      event: { id: existing.id, title: "Réunion modifiée" },
    });
    expect(await screen.findByText("Réunion modifiée")).toBeInTheDocument();
  });

  it("édite un événement horaire sans changer son fuseau ni son instant", async () => {
    const user = userEvent.setup();
    const existing = event({
      id: "event-ny",
      uid: "event-ny@dayali.local",
      title: "Appel New York",
      allDay: false,
      start: { dateTime: "2026-10-27T14:00:00.000Z", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-27T15:00:00.000Z", timeZone: "America/New_York" },
    });
    const base = setup([existing]);
    const save = vi.fn(base.calendarSave);
    configureIpc({ ...base, calendarSave: save });
    renderScreen();

    expect(await screen.findByText("Appel New York")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().agenda.refs[existing.id]).toBeDefined());
    await user.click(screen.getByRole("button", { name: "Modifier « Appel New York »" }));
    const titleInput = screen.getByLabelText("Titre de l'événement");
    await user.clear(titleInput);
    await user.type(titleInput, "Appel New York reporté");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("Événement modifié.")).toBeInTheDocument();
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      event: {
        start: { dateTime: "2026-10-27T14:00:00.000Z", timeZone: "America/New_York" },
        end: { dateTime: "2026-10-27T15:00:00.000Z", timeZone: "America/New_York" },
      },
    });
  });

  it("supprime uniquement après confirmation explicite", async () => {
    const user = userEvent.setup();
    const existing = event();
    const base = setup([existing]);
    const remove = vi.fn(base.calendarDelete);
    configureIpc({ ...base, calendarDelete: remove });
    renderScreen();

    expect(await screen.findByText("Réunion")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().agenda.refs[existing.id]).toBeDefined());
    const expected = useAppStore.getState().agenda.refs[existing.id];

    await user.click(screen.getByRole("button", { name: "Supprimer « Réunion »" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Supprimer « Réunion » ?");
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText("Réunion")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Supprimer « Réunion »" }));
    await user.click(screen.getByRole("button", { name: "Confirmer la suppression" }));

    expect(await screen.findByText("Événement supprimé.")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledWith({ eventId: existing.id, expected });
    await waitFor(() => expect(screen.queryByText("Réunion")).not.toBeInTheDocument());
  });

  it("affiche un conflit de hash et ne prétend pas avoir enregistré", async () => {
    const user = userEvent.setup();
    const existing = event();
    const base = setup([existing]);
    renderScreen();

    expect(await screen.findByText("Réunion")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().agenda.refs[existing.id]).toBeDefined());

    // Écriture concurrente : le hash chargé par l'UI devient périmé.
    const current = await base.calendarFileRef({ id: existing.id });
    await base.calendarSave({
      event: { ...existing, title: "Version autre machine" },
      expected: current.hash,
    });

    await user.click(screen.getByRole("button", { name: "Modifier « Réunion »" }));
    const titleInput = screen.getByLabelText("Titre de l'événement");
    await user.clear(titleInput);
    await user.type(titleInput, "Version utilisateur");
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("E_PRECONDITION_FAILED");
    expect(alert).toHaveTextContent(/changé entre-temps/);
    expect(screen.getByRole("button", { name: "Recharger" })).toBeInTheDocument();
    expect(screen.queryByText("Événement modifié.")).not.toBeInTheDocument();
    expect(screen.getByText("Réunion")).toBeInTheDocument();
  });
});

describe("CalendarScreen — avertissements et états", () => {
  it("affiche les avertissements de lecture et recharge la fenêtre", async () => {
    const user = userEvent.setup();
    const warning =
      "calendar/0199a1b2-0000-7000-8000-000000000401.ics : E_SCHEMA_INVALID — ligne illisible";
    const base = setup([], [warning]);
    const list = vi.fn(base.calendarList);
    configureIpc({ ...base, calendarList: list });
    renderScreen();

    const status = await screen.findByTestId("agenda-warnings");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(warning);
    expect(status).toHaveTextContent("fichier non modifié");
    const callsBefore = list.mock.calls.length;

    await user.click(within(status).getByRole("button", { name: "Recharger" }));

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("affiche un état vide honnête sans faux événement", async () => {
    setup();
    renderScreen();

    expect(
      await screen.findByText("Aucun événement du jour ni dans les 30 jours suivants."),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("CalendarScreen — vues multiples et navigation", () => {
  it("permet de basculer entre les vues Jour, 3 jours, Semaine, Mois, Année et Liste et navigue dans le temps", async () => {
    const user = userEvent.setup();
    const existing = event({ start: { date: "2026-10-27" }, end: { date: "2026-10-28" } });
    setup([existing]);
    renderScreen();

    expect(await screen.findByText("Réunion")).toBeInTheDocument();

    // Boutons de vues
    const dayTab = screen.getByRole("tab", { name: "Jour" });
    const threeDaysTab = screen.getByRole("tab", { name: "3 jours" });
    const weekTab = screen.getByRole("tab", { name: "Semaine" });
    const monthTab = screen.getByRole("tab", { name: "Mois" });
    const yearTab = screen.getByRole("tab", { name: "Année" });
    const listTab = screen.getByRole("tab", { name: "Liste" });

    expect(listTab).toHaveAttribute("aria-selected", "true");

    // Basculer en vue Jour
    await user.click(dayTab);
    expect(dayTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Réunion")).toBeInTheDocument();

    // Basculer en vue 3 jours
    await user.click(threeDaysTab);
    expect(threeDaysTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Réunion")).toBeInTheDocument();

    // Basculer en vue Semaine
    await user.click(weekTab);
    expect(weekTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Réunion")).toBeInTheDocument();

    // Basculer en vue Mois
    await user.click(monthTab);
    expect(monthTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("octobre 2026")).toBeInTheDocument();

    // Basculer en vue Année
    await user.click(yearTab);
    expect(yearTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("2026")).toBeInTheDocument();
    expect(screen.getByText("janvier")).toBeInTheDocument();
    expect(screen.getByText("décembre")).toBeInTheDocument();

    // Basculer en vue Liste
    await user.click(listTab);
    expect(listTab).toHaveAttribute("aria-selected", "true");

    // Navigation temporelle
    await user.click(screen.getByRole("button", { name: /période précédente/i }));
    await user.click(screen.getByRole("button", { name: "Aujourd'hui" }));
    await user.click(screen.getByRole("button", { name: /période suivante/i }));
  });

  it("ouvre la vue jour lorsqu'on clique sur un jour depuis la vue mois ou année", async () => {
    const user = userEvent.setup();
    const existing = event({ start: { date: "2026-10-27" }, end: { date: "2026-10-28" } });
    setup([existing]);
    renderScreen();

    expect(await screen.findByText("Réunion")).toBeInTheDocument();

    // Aller en vue mois
    await user.click(screen.getByRole("tab", { name: "Mois" }));
    expect(screen.getByRole("tab", { name: "Mois" })).toHaveAttribute("aria-selected", "true");

    // Cliquer sur le bouton du jour 27
    const day27Btn = screen.getByRole("button", { name: "27" });
    await user.click(day27Btn);

    // Bascule en vue Jour
    expect(screen.getByRole("tab", { name: "Jour" })).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getAllByRole("heading", { name: /27 octobre 2026/ }).length,
    ).toBeGreaterThanOrEqual(1);

    // Aller en vue année
    await user.click(screen.getByRole("tab", { name: "Année" }));
    expect(screen.getByRole("tab", { name: "Année" })).toHaveAttribute("aria-selected", "true");

    // Cliquer sur le mois 'décembre' bascule en vue mois
    await user.click(screen.getByRole("button", { name: "décembre" }));
    expect(screen.getByRole("tab", { name: "Mois" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("décembre 2026")).toBeInTheDocument();
  });
});

describe("CalendarScreen — blocs horaires posés sur la grille", () => {
  it("positionne un bloc par son heure et sa durée au lieu de l'intégrer à la ligne", async () => {
    const user = userEvent.setup();
    const existing = event({
      id: "event-timed",
      uid: "event-timed@dayali.local",
      allDay: false,
      start: { dateTime: "2026-10-27T08:00:00.000Z", timeZone: PARIS },
      end: { dateTime: "2026-10-27T09:30:00.000Z", timeZone: PARIS },
    });
    setup([existing]);
    renderScreen();

    await screen.findByText("Réunion");
    await user.click(screen.getByRole("tab", { name: "Semaine" }));

    const block = screen.getByRole("button", { name: "Modifier « Réunion »" });
    const slot = block.parentElement;
    // 09:00 locale = 2 h après le début de la grille (07:00) sur 16 h ; durée 1 h 30.
    expect(slot?.style.top).toBe("12.5%");
    expect(slot?.style.height).toBe("9.375%");
    expect(slot?.style.left).toBe("0%");
    expect(slot?.style.width).toBe("100%");
  });

  it("partage la largeur entre deux événements qui se chevauchent", async () => {
    const user = userEvent.setup();
    const first = event({
      id: "event-a",
      uid: "event-a@dayali.local",
      allDay: false,
      start: { dateTime: "2026-10-27T07:00:00.000Z", timeZone: PARIS },
      end: { dateTime: "2026-10-27T08:00:00.000Z", timeZone: PARIS },
    });
    const second = event({
      id: "event-b",
      uid: "event-b@dayali.local",
      title: "Point",
      allDay: false,
      start: { dateTime: "2026-10-27T07:30:00.000Z", timeZone: PARIS },
      end: { dateTime: "2026-10-27T08:30:00.000Z", timeZone: PARIS },
    });
    setup([first, second]);
    renderScreen();

    await screen.findByText("Réunion");
    await user.click(screen.getByRole("tab", { name: "Semaine" }));

    const reunion = screen.getByRole("button", { name: "Modifier « Réunion »" }).parentElement;
    const point = screen.getByRole("button", { name: "Modifier « Point »" }).parentElement;
    expect(reunion?.style.width).toBe("50%");
    expect(reunion?.style.left).toBe("0%");
    expect(point?.style.width).toBe("50%");
    expect(point?.style.left).toBe("50%");
  });

  it("supprime depuis la boîte de dialogue qu'un bloc de la grille ouvre", async () => {
    const user = userEvent.setup();
    const existing = event({
      id: "event-grid",
      uid: "event-grid@dayali.local",
      allDay: false,
      start: { dateTime: "2026-10-27T08:00:00.000Z", timeZone: PARIS },
      end: { dateTime: "2026-10-27T09:00:00.000Z", timeZone: PARIS },
    });
    const base = setup([existing]);
    const remove = vi.fn(base.calendarDelete);
    configureIpc({ ...base, calendarDelete: remove });
    renderScreen();

    await screen.findByText("Réunion");
    await waitFor(() => expect(useAppStore.getState().agenda.refs[existing.id]).toBeDefined());
    const expected = useAppStore.getState().agenda.refs[existing.id];

    // En vue Semaine il n'y a plus de carte : le bloc ne propose que la boîte de dialogue,
    // qui devient donc le seul chemin de suppression de la grille.
    await user.click(screen.getByRole("tab", { name: "Semaine" }));
    const dialog = screen.getByTestId("calendar-event-dialog");
    expect(screen.queryByRole("button", { name: "Supprimer « Réunion »" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Modifier « Réunion »" }));
    await waitFor(() => expect(dialog).toHaveAttribute("open"));

    await user.click(screen.getByRole("button", { name: "Supprimer « Réunion »" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Supprimer « Réunion » ?");

    await user.click(screen.getByRole("button", { name: "Confirmer la suppression" }));

    expect(await screen.findByText("Événement supprimé.")).toBeInTheDocument();
    expect(remove).toHaveBeenCalledWith({ eventId: existing.id, expected });
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    await waitFor(() => expect(screen.queryByText("Réunion")).not.toBeInTheDocument());
  });
});
