import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import bundledQuotes from "../../assets/quotes-fr.json";
import type { LocalCalendarEvent, Reminder } from "../../lib/contracts/types";
import { TodayScreen, type TodayScreenProps } from "./TodayScreen";

const NOW = new Date("2026-10-27T02:30:00.000Z"); // 03:30 à Paris (CET)

const QUOTES = bundledQuotes as readonly {
  readonly text: string;
  readonly author: string;
}[];

/**
 * Même sélection que `quoteOfTheDay` du composant : index dérivé du
 * `greetingSeed`, sans citation codée en dur dans le test.
 */
function expectedQuote(seed: number) {
  const index = ((seed % QUOTES.length) + QUOTES.length) % QUOTES.length;
  return QUOTES[index];
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    schemaVersion: 1,
    id: "r1",
    listId: "l1",
    title: "Préparer la journée",
    notes: null,
    status: "open",
    dueDate: "2026-10-26",
    dueTime: "09:00",
    dueTimeZone: "Europe/Paris",
    projectId: null,
    completedAt: null,
    recurrence: null,
    sortKey: null,
    createdAt: "2026-10-20T07:10:00.000Z",
    updatedAt: "2026-10-20T07:10:00.000Z",
    machineId: "machine-test",
    ...overrides,
  };
}

function calendarEvent(overrides: Partial<LocalCalendarEvent> = {}): LocalCalendarEvent {
  return {
    id: "event-1",
    uid: "event-1@dayali.local",
    calendarId: "local",
    title: "Réunion d'équipe",
    description: null,
    location: null,
    allDay: false,
    start: { dateTime: "2026-10-26T08:00:00.000Z", timeZone: "Europe/Paris" },
    end: { dateTime: "2026-10-26T09:00:00.000Z", timeZone: "Europe/Paris" },
    projectId: null,
    machineId: "machine-test",
    createdAt: "2026-10-20T07:10:00.000Z",
    updatedAt: "2026-10-20T07:10:00.000Z",
    sequence: 0,
    status: "confirmed",
    ...overrides,
  };
}

function renderToday(overrides: Partial<TodayScreenProps> = {}) {
  const props: TodayScreenProps = {
    now: NOW,
    timeZone: "Europe/Paris",
    locale: "fr-FR",
    civilDate: "2026-10-27",
    logicalDate: "2026-10-26",
    greetingVariants: true,
    greetingSeed: 1,
    startedToday: false,
    lastDayStartedAt: null,
    busy: false,
    onStartDay: vi.fn().mockResolvedValue(true),
    onEnterPreview: vi.fn(),
    onRetryReminders: vi.fn(),
    onRetryAgenda: vi.fn(),
    reminders: [],
    remindersStatus: "idle",
    remindersError: null,
    agenda: [],
    agendaStatus: "idle",
    agendaError: null,
    agendaWarnings: [],
    carryOvers: [],
    carryOverWarnings: [],
    onOpenDashboard: vi.fn(),
    ...overrides,
  };
  const utils = render(<TodayScreen {...props} />);
  return { ...utils, props };
}

describe("TodayScreen — état accueil", () => {
  it("ne rend pas un report abandonné", async () => {
    renderToday({ carryOvers: [reminder({ status: "abandoned", title: "Ne pas afficher" })] });
    await userEvent.setup().click(screen.getByRole("button", { name: "Démarrer la journée" }));
    expect(screen.queryByText("Ne pas afficher")).not.toBeInTheDocument();
  });
  it("affiche l'heure dans un <time>, la salutation, la date, la citation et le bouton", () => {
    const { props } = renderToday();

    const clock = screen.getByText("03:30");
    const time = clock.closest("time");
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute("dateTime", "2026-10-27T03:30:00");
    expect(time).toHaveTextContent("3 heures 30 minutes");

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("La nuit est calme.");
    expect(screen.getByText("mardi 27 octobre 2026")).toBeInTheDocument();

    const quote = screen.getByTestId("daily-quote");
    const expected = expectedQuote(props.greetingSeed);
    expect(QUOTES.length).toBeGreaterThan(0);
    expect(expected?.text.trim()).not.toBe("");
    expect(expected?.author.trim()).not.toBe("");
    expect(quote).toHaveTextContent(`« ${expected?.text} »`);
    expect(quote).toHaveTextContent(`${expected?.author}`);

    expect(screen.getByRole("button", { name: "Démarrer la journée" })).toBeInTheDocument();
    expect(screen.getByText("Entrée")).toBeInTheDocument();
  });

  it("n'expose aucune navigation ni changement de vault sur l'accueil", () => {
    renderToday();

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Accueil|Dashboard|Rappels/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Changer de vault/ })).not.toBeInTheDocument();
  });

  it("le lien d'évitement place le focus sur le contenu sans changer l'URL", async () => {
    const user = userEvent.setup();
    renderToday();
    const before = window.location.hash;

    await user.click(screen.getByRole("link", { name: "Aller au contenu" }));

    expect(screen.getByRole("main")).toHaveFocus();
    expect(window.location.hash).toBe(before);
  });

  it("n'affiche aucun crédit sans photo, et le crédit exact si une photo est fournie", () => {
    const { rerender, props } = renderToday();
    expect(screen.queryByTestId("photo-credit")).not.toBeInTheDocument();

    rerender(
      <TodayScreen
        {...props}
        photo={{ src: "/images/home.jpg", credit: "Jane Doe", license: "Unsplash License" }}
      />,
    );

    const credit = screen.getByTestId("photo-credit");
    expect(credit).toHaveTextContent("Jane Doe");
    expect(credit).toHaveTextContent("Unsplash License");

    rerender(
      <TodayScreen
        {...props}
        photo={{
          src: "/images/home.jpg",
          credit: "Jane Doe",
          license: "Unsplash License",
          provider: "unsplash",
          source: "https://unsplash.com/photos/xyz",
        }}
      />,
    );

    const unsplashCredit = screen.getByTestId("photo-credit");
    expect(unsplashCredit).toHaveTextContent("Photo de Jane Doe sur Unsplash");
    expect(unsplashCredit).not.toHaveTextContent("Unsplash License");
  });
});

describe("TodayScreen — transition accueil → aperçu", () => {
  it("passe à l'aperçu au clic quand onStartDay réussit", async () => {
    const user = userEvent.setup();
    const onStartDay = vi.fn().mockResolvedValue(true);
    const onEnterPreview = vi.fn();
    renderToday({ onStartDay, onEnterPreview });

    await user.click(screen.getByRole("button", { name: "Démarrer la journée" }));

    expect(await screen.findByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
    expect(onStartDay).toHaveBeenCalledTimes(1);
    expect(onEnterPreview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Votre journée" })).toHaveFocus();
  });

  it("affiche l'aperçu du jour avec rappels et agenda visibles et bouton de démarrage absent après un clic sur Démarrer la journée", async () => {
    const user = userEvent.setup();
    const onStartDay = vi.fn().mockResolvedValue(true);
    const onEnterPreview = vi.fn();
    renderToday({
      onStartDay,
      onEnterPreview,
      remindersStatus: "ready",
      agendaStatus: "ready",
      reminders: [reminder()],
      agenda: [calendarEvent()],
    });

    const startButton = screen.getByRole("button", { name: "Démarrer la journée" });
    expect(startButton).toBeInTheDocument();

    await user.click(startButton);

    expect(await screen.findByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Rappels du jour" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agenda du jour" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Démarrer la journée" })).not.toBeInTheDocument();
    expect(onStartDay).toHaveBeenCalledTimes(1);
    expect(onEnterPreview).toHaveBeenCalledTimes(1);
  });

  it("passe à l'aperçu avec la touche Entrée hors contrôle interactif", async () => {
    const user = userEvent.setup();
    const onStartDay = vi.fn().mockResolvedValue(true);
    const onEnterPreview = vi.fn();
    renderToday({ onStartDay, onEnterPreview });

    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
    expect(onStartDay).toHaveBeenCalledTimes(1);
    expect(onEnterPreview).toHaveBeenCalledTimes(1);
  });

  it("n'agit pas deux fois quand Entrée est pressée sur le bouton", async () => {
    const user = userEvent.setup();
    const onStartDay = vi.fn().mockResolvedValue(true);
    renderToday({ onStartDay });

    screen.getByRole("button", { name: "Démarrer la journée" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
    expect(onStartDay).toHaveBeenCalledTimes(1);
  });

  it("reste sur l'accueil si onStartDay échoue", async () => {
    const user = userEvent.setup();
    const onStartDay = vi.fn().mockResolvedValue(false);
    const onEnterPreview = vi.fn();
    renderToday({ onStartDay, onEnterPreview });

    const button = screen.getByRole("button", { name: "Démarrer la journée" });
    await user.click(button);

    await waitFor(() => expect(onStartDay).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.queryByRole("heading", { name: "Votre journée" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Démarrer la journée" })).toBeInTheDocument();
    expect(onEnterPreview).not.toHaveBeenCalled();
  });

  it("affiche « Voir ma journée » quand la journée est déjà démarrée, sans second démarrage", async () => {
    const user = userEvent.setup();
    const onStartDay = vi.fn().mockResolvedValue(true);
    renderToday({
      startedToday: true,
      lastDayStartedAt: "2026-10-26T06:42:11.000Z",
      onStartDay,
    });

    expect(screen.queryByRole("button", { name: "Démarrer la journée" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Voir ma journée" }));
    expect(onStartDay).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
  });
});

describe("TodayScreen — Vague B (Expérience de début de journée)", () => {
  it("valide l'expérience d'accueil épurée, centrée et cinématique", () => {
    const { props } = renderToday();

    // 1. Pas de mention redondante « Heure locale » ni « Journée du »
    expect(screen.queryByText("Heure locale")).not.toBeInTheDocument();
    expect(screen.queryByText(/Journée du/)).not.toBeInTheDocument();

    // 2. Horloge, salutation, date et bouton présents
    expect(screen.getByText("03:30")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("La nuit est calme.");
    expect(screen.getByText("mardi 27 octobre 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Démarrer la journée" })).toBeInTheDocument();

    // 3. Citation avec auteur naturel (sans tiret cadratin dans le footer)
    const quote = screen.getByTestId("daily-quote");
    const expected = expectedQuote(props.greetingSeed);
    expect(quote).toHaveTextContent(expected?.author ?? "");
    expect(quote.querySelector("footer")?.textContent).not.toContain("—");

    // 4. Clarification du raccourci Entrée
    expect(screen.getByText("Entrée")).toBeInTheDocument();
    expect(screen.getByText("Appuyez pour démarrer")).toBeInTheDocument();
  });
});

describe("TodayScreen — état aperçu", () => {
  it("affiche les rappels réels, l'agenda du jour vide et le bouton du dashboard", () => {
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      agendaStatus: "ready",
      reminders: [
        reminder(),
        reminder({
          id: "r2",
          title: "Relancer le dossier",
          dueDate: "2026-10-24",
          dueTime: null,
          dueTimeZone: null,
        }),
      ],
      carryOvers: [
        reminder({
          id: "r3",
          title: "Ranger les notes d'hier",
          dueDate: "2026-10-25",
          dueTime: null,
          dueTimeZone: null,
        }),
      ],
    });

    expect(screen.getByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
    expect(screen.getByText("Préparer la journée")).toBeInTheDocument();
    expect(screen.getByText("Relancer le dossier")).toBeInTheDocument();
    expect(screen.getAllByText("En retard").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Agenda du jour" })).toBeInTheDocument();
    expect(screen.getByText("Aucun événement aujourd'hui.")).toBeInTheDocument();
    expect(screen.queryByText(/0 événement/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Report de la veille" })).toBeInTheDocument();
    expect(screen.getByText("Ranger les notes d'hier")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ouvrir le dashboard" })).toBeInTheDocument();
  });

  it("affiche les vrais événements du jour, journée entière puis horaires", () => {
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      agendaStatus: "ready",
      agenda: [
        calendarEvent({
          id: "event-allday",
          uid: "event-allday@dayali.local",
          title: "Journée portes ouvertes",
          allDay: true,
          start: { date: "2026-10-26" },
          end: { date: "2026-10-27" },
        }),
        calendarEvent({ title: "Réunion d'équipe", location: "Salle 2" }),
      ],
    });

    const agendaTitle = screen.getByRole("heading", { name: "Agenda du jour" });
    const panel = agendaTitle.closest("section");
    expect(panel).not.toBeNull();
    expect(panel).toHaveTextContent("Journée portes ouvertes");
    expect(panel).toHaveTextContent("Journée entière");
    expect(panel).toHaveTextContent("Réunion d'équipe");
    expect(panel).toHaveTextContent("09:00 – 10:00");
    expect(panel).toHaveTextContent("Salle 2");
    expect(screen.queryByText("Aucun événement aujourd'hui.")).not.toBeInTheDocument();
  });

  it("signale l'événement en cours sur l'agenda du jour", () => {
    renderToday({
      initialPhase: "preview",
      // 09:30 à Paris : la réunion 09:00 – 10:00 est en cours.
      now: new Date("2026-10-26T08:30:00.000Z"),
      remindersStatus: "ready",
      agendaStatus: "ready",
      agenda: [calendarEvent({ title: "Réunion d'équipe", location: "Salle 2" })],
    });

    const panel = screen.getByRole("heading", { name: "Agenda du jour" }).closest("section");
    expect(panel).toHaveTextContent("Réunion d'équipe");
    expect(panel).toHaveTextContent("En cours");
  });

  it("affiche les avertissements d'agenda sans les masquer", () => {
    const warning =
      "calendar/0199a1b2-0000-7000-8000-000000000401.ics : E_SCHEMA_INVALID — ligne illisible";
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      agendaStatus: "ready",
      agendaWarnings: [warning],
    });

    const status = screen.getByTestId("agenda-warnings");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(warning);
    expect(status).toHaveTextContent("fichier non modifié");
  });

  it("affiche l'erreur d'agenda réelle et permet de recharger", async () => {
    const user = userEvent.setup();
    const onRetryAgenda = vi.fn();
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      agendaStatus: "error",
      agendaError: { code: "E_INTERNAL", message: "Calendrier illisible.", retryable: true },
      onRetryAgenda,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Calendrier illisible.");
    expect(screen.queryByText("Réunion d'équipe")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Recharger" }));
    expect(onRetryAgenda).toHaveBeenCalledTimes(1);
  });

  it("n'affiche pas de section « Report de la veille » quand il n'y a rien à reporter", () => {
    renderToday({ initialPhase: "preview", remindersStatus: "ready" });
    expect(screen.queryByRole("heading", { name: "Report de la veille" })).not.toBeInTheDocument();
  });

  it("affiche les rappels illisibles ignorés sans bloquer l'aperçu", () => {
    const warning =
      "reminders/0199a1b2-0000-7000-8000-000000000302.json : E_SCHEMA_INVALID — JSON invalide (ligne 1, colonne 1)";
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      carryOverWarnings: [warning],
    });

    const status = screen.getByTestId("carry-over-warnings");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("Rappel illisible ignoré");
    expect(status).toHaveTextContent(warning);
    expect(status).toHaveTextContent("fichier non modifié");
    // L'accueil/aperçu reste fonctionnel malgré l'avertissement.
    expect(screen.getByRole("heading", { name: "Votre journée" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ouvrir le dashboard" })).toBeInTheDocument();
  });

  it("n'affiche aucune zone d'avertissement quand la liste est vide", () => {
    renderToday({ initialPhase: "preview", remindersStatus: "ready", carryOverWarnings: [] });
    expect(screen.queryByTestId("carry-over-warnings")).not.toBeInTheDocument();
    expect(screen.queryByText(/Rappel illisible ignoré/)).not.toBeInTheDocument();
  });

  it("annonce honnêtement l'absence de rappel sans fausse ligne", () => {
    renderToday({ initialPhase: "preview", remindersStatus: "ready", reminders: [] });

    expect(screen.getByText("Aucun rappel à traiter aujourd'hui.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("affiche le chargement des rappels", () => {
    renderToday({ initialPhase: "preview", remindersStatus: "loading" });
    expect(screen.getByText("Chargement des rappels…")).toBeInTheDocument();
  });

  it("affiche l'erreur réelle et permet de réessayer", async () => {
    const user = userEvent.setup();
    const onRetryReminders = vi.fn();
    renderToday({
      initialPhase: "preview",
      remindersStatus: "error",
      remindersError: { code: "E_INTERNAL", message: "Disque illisible.", retryable: true },
      onRetryReminders,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Disque illisible.");
    await user.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(onRetryReminders).toHaveBeenCalledTimes(1);
  });

  it("masque la section Report de la veille si le report a déjà été demandé (absent des carryOvers)", () => {
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      carryOvers: [], // Filtré par le backend car déjà dans l'historique
    });
    expect(screen.queryByRole("heading", { name: "Report de la veille" })).not.toBeInTheDocument();
  });

  it("formate les échéances des rappels dans l'aperçu sans fuseau horaire (UTC)", () => {
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      reminders: [
        reminder({
          title: "Rappel test Heure",
          dueDate: "2026-10-26",
          dueTime: "14:30",
          dueTimeZone: "Europe/Paris",
        }),
      ],
    });

    const item = screen.getByText("Rappel test Heure").closest("li");
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("14:30");
    expect(item?.textContent).not.toContain("UTC");
    expect(item?.textContent).not.toContain("Europe/Paris");
  });
});

describe("TodayScreen — reste d'une journée non fermée", () => {
  const leftover = () =>
    reminder({
      id: "r-left",
      title: "Appeler le garage",
      dueDate: "2026-10-25",
      dueTime: null,
      dueTimeZone: null,
    });

  function renderPreview(onResolveCarryOver = vi.fn().mockResolvedValue(undefined)) {
    renderToday({
      initialPhase: "preview",
      remindersStatus: "ready",
      carryOvers: [leftover()],
      onResolveCarryOver,
    });
    return onResolveCarryOver;
  }

  it("affiche le report avant le résumé de la journée", () => {
    renderPreview();

    const carry = screen.getByRole("heading", { name: "Report de la veille" });
    const today = screen.getByRole("heading", { name: "Rappels du jour" });
    expect(carry.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("replanifie pour aujourd'hui en un clic", async () => {
    const user = userEvent.setup();
    const onResolve = renderPreview();

    await user.click(screen.getByRole("button", { name: /Replanifier aujourd'hui/ }));

    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ id: "r-left" }), {
      action: "replan",
      newDueDate: "2026-10-26",
    });
  });

  it("replanifie demain ou un autre jour de la semaine", async () => {
    const user = userEvent.setup();
    const onResolve = renderPreview();

    await user.click(screen.getByRole("button", { name: /Replanifier demain/ }));
    expect(onResolve).toHaveBeenLastCalledWith(expect.anything(), {
      action: "replan",
      newDueDate: "2026-10-27",
    });

    await user.click(screen.getByRole("button", { name: /Choisir un autre jour/ }));
    const input = screen.getByLabelText("Nouvelle échéance");
    await user.clear(input);
    await user.type(input, "2026-10-30");
    await user.click(screen.getByRole("button", { name: /Valider la nouvelle échéance/ }));
    expect(onResolve).toHaveBeenLastCalledWith(expect.anything(), {
      action: "replan",
      newDueDate: "2026-10-30",
    });
  });

  it("permet d'abandonner le reste", async () => {
    const user = userEvent.setup();
    const onResolve = renderPreview();

    await user.click(screen.getByRole("button", { name: /Abandonner/ }));

    expect(onResolve).toHaveBeenCalledWith(expect.anything(), { action: "abandon" });
  });

  it("affiche l'erreur sur la ligne concernée et réactive les boutons", async () => {
    const user = userEvent.setup();
    renderPreview(vi.fn().mockRejectedValue(new Error("boom")));

    await user.click(screen.getByRole("button", { name: /Replanifier aujourd'hui/ }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replanifier aujourd'hui/ })).toBeEnabled();
  });

  it("reste en lecture seule sans gestionnaire de décision", () => {
    renderToday({ initialPhase: "preview", remindersStatus: "ready", carryOvers: [leftover()] });

    expect(screen.getByText("Appeler le garage")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Replanifier/ })).not.toBeInTheDocument();
  });
});
