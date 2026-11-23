import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarItem, Reminder, SavedView, WidgetPlacement } from "../../lib/contracts/types";
import { configureIpc, resetIpc } from "../../lib/ipc";
import { CalendarWidget } from "./CalendarWidget";
import { ReminderWidget } from "./ReminderWidget";
import { calendarView, remindersView } from "./viewAdapters";

const placement = {
  id: "w",
  module: "reminders",
  viewId: "v",
  layout: { x: 0, y: 0, w: 2, h: 2 },
  enabled: true,
} as WidgetPlacement;
const reminderView = {
  id: "v",
  module: "reminders",
  name: "Rappels",
  origin: "user",
  filter: { statuses: ["open"] },
  createdAt: "x",
  updatedAt: "x",
} as SavedView;
const agendaView = {
  ...reminderView,
  module: "agenda",
  filter: { rangeDays: 1, includeAllDay: true },
} as SavedView;
const reminder = { id: "r", title: "Acheter du lait", dueDate: "2026-11-12" } as Reminder;
const event = {
  calendarId: "c",
  uid: "e",
  title: "Réunion",
  allDay: true,
  start: { date: "2026-11-12" },
  end: { date: "2026-11-13" },
} as CalendarItem;

beforeEach(() => resetIpc());

describe("view adapters", () => {
  it("valide les filtres du contrat et refuse les formes invalides", () => {
    expect(remindersView(reminderView).kind).toBe("ready");
    expect(calendarView(agendaView).kind).toBe("ready");
    expect(remindersView(undefined).kind).toBe("incompatible");
    expect(remindersView({ ...reminderView, filter: { dueWithinDays: 366 } }).kind).toBe(
      "incompatible",
    );
    expect(calendarView({ ...agendaView, filter: { rangeDays: 0 } }).kind).toBe("incompatible");
    expect(calendarView({ ...agendaView, module: "reminders" }).kind).toBe("incompatible");
  });
});

describe("ReminderWidget", () => {
  it("rend des données prêtes et l'état vide", () => {
    const { rerender } = render(
      <ReminderWidget
        placement={placement}
        view={reminderView}
        logicalDate="2026-11-12"
        injectedItems={[reminder]}
      />,
    );
    expect(screen.getByText(/Acheter du lait/)).toBeInTheDocument();
    rerender(
      <ReminderWidget
        placement={placement}
        view={reminderView}
        logicalDate="2026-11-12"
        injectedItems={[]}
      />,
    );
    expect(screen.getByText("Aucun rappel à faire pour cette vue.")).toBeInTheDocument();
  });

  it("masque les rappels abandonnés sans masquer les autres", () => {
    render(
      <ReminderWidget
        placement={placement}
        view={reminderView}
        logicalDate="2026-11-12"
        injectedItems={[
          reminder,
          { ...reminder, id: "abandoned", title: "À ne pas afficher", status: "abandoned" },
        ]}
      />,
    );
    expect(screen.getByText(/Acheter du lait/)).toBeInTheDocument();
    expect(screen.queryByText("À ne pas afficher")).not.toBeInTheDocument();
  });

  it("affiche une erreur sans conserver les anciennes données après rechargement", async () => {
    const reminderList = vi
      .fn()
      .mockResolvedValueOnce([reminder])
      .mockRejectedValueOnce(new Error("lecture impossible"));
    // reminderFileRef et reminderListDefs sont appelés après reminderList.
    const reminderFileRef = vi.fn().mockResolvedValue({ hash: "abc123" });
    const reminderListDefs = vi.fn().mockResolvedValue([]);
    configureIpc({ reminderList, reminderFileRef, reminderListDefs } as never);
    const { rerender } = render(
      <ReminderWidget placement={placement} view={reminderView} logicalDate="2026-11-12" />,
    );
    await waitFor(() => expect(screen.getByText(/Acheter du lait/)).toBeInTheDocument());
    rerender(
      <ReminderWidget
        placement={placement}
        view={{ ...reminderView, filter: { statuses: ["done"] } }}
        logicalDate="2026-11-12"
      />,
    );
    await waitFor(() => expect(screen.getByText(/lecture impossible/)).toBeInTheDocument());
    expect(screen.queryByText(/Acheter du lait/)).not.toBeInTheDocument();
  });
});

describe("CalendarWidget", () => {
  it("rend les données, le vide et les avertissements Agenda", () => {
    const { rerender } = render(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={agendaView}
        logicalDate="2026-11-12"
        injectedItems={[event]}
        injectedWarnings={["fichier ignoré"]}
      />,
    );
    expect(screen.getByText(/Réunion/)).toBeInTheDocument();
    expect(screen.getByText(/fichier ignoré/)).toBeInTheDocument();
    rerender(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={agendaView}
        logicalDate="2026-11-12"
        injectedItems={[]}
        injectedReminders={[]}
      />,
    );
    // Vue « Aujourd'hui » vide : la journée est terminée, pas « aucune période ».
    expect(screen.getByText("C’est tout pour aujourd’hui")).toBeInTheDocument();

    rerender(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={{ ...agendaView, filter: { rangeDays: 7, includeAllDay: true } }}
        logicalDate="2026-11-12"
        injectedItems={[]}
      />,
    );
    expect(screen.getByText("Aucun événement sur cette période.")).toBeInTheDocument();
  });

  it("ne garde que le jour logique et retire les événements terminés", () => {
    const timed = (uid: string, title: string, day: string, from: string, to: string) =>
      ({
        calendarId: "c",
        uid,
        title,
        allDay: false,
        start: { dateTime: `${day}T${from}:00.000Z`, timeZone: "UTC" },
        end: { dateTime: `${day}T${to}:00.000Z`, timeZone: "UTC" },
      }) as unknown as CalendarItem;

    render(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={agendaView}
        logicalDate="2026-11-12"
        locale="fr-FR"
        now={new Date("2026-11-12T12:00:00.000Z")}
        injectedItems={[
          timed("past", "Petit-déjeuner", "2026-11-12", "07:00", "08:00"),
          timed("next", "Cours de droit", "2026-11-12", "14:00", "15:00"),
          timed("tomorrow", "Rendez-vous dentiste", "2026-11-13", "09:00", "10:00"),
        ]}
      />,
    );

    expect(screen.getByText("Cours de droit")).toBeInTheDocument();
    expect(screen.queryByText("Petit-déjeuner")).not.toBeInTheDocument();
    expect(screen.queryByText("Rendez-vous dentiste")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Passés" })).not.toBeInTheDocument();
  });

  it("affiche la journée terminée, avec puis sans tâches restantes", () => {
    const past = {
      calendarId: "c",
      uid: "past-done",
      title: "Petit-déjeuner",
      allDay: false,
      start: { dateTime: "2026-11-12T07:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-12T08:00:00.000Z", timeZone: "UTC" },
    } as unknown as CalendarItem;

    const { rerender } = render(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={agendaView}
        logicalDate="2026-11-12"
        locale="fr-FR"
        now={new Date("2026-11-12T20:00:00.000Z")}
        injectedItems={[past]}
        injectedReminders={[
          { ...reminder, status: "open" },
          { ...reminder, id: "r2", status: "open" },
        ]}
      />,
    );

    expect(screen.getByText("C’est tout pour aujourd’hui")).toBeInTheDocument();
    expect(screen.getByText(/Il vous reste quelques tâches à faire/)).toBeInTheDocument();
    expect(screen.queryByText("Petit-déjeuner")).not.toBeInTheDocument();

    rerender(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={agendaView}
        logicalDate="2026-11-12"
        locale="fr-FR"
        now={new Date("2026-11-12T20:00:00.000Z")}
        injectedItems={[past]}
        injectedReminders={[]}
      />,
    );
    expect(screen.getByText("C’est tout pour aujourd’hui")).toBeInTheDocument();
    expect(screen.queryByText(/Il vous reste/)).not.toBeInTheDocument();
  });

  it("met en avant l'événement en cours avec son horaire et son lieu", () => {
    const ongoing = {
      calendarId: "c",
      uid: "ongoing",
      title: "Point d'équipe",
      allDay: false,
      location: "Salle 2",
      start: { dateTime: "2026-11-12T10:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-12T11:00:00.000Z", timeZone: "UTC" },
    } as unknown as CalendarItem;

    render(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={agendaView}
        logicalDate="2026-11-12"
        locale="fr-FR"
        now={new Date("2026-11-12T10:30:00.000Z")}
        injectedItems={[ongoing]}
      />,
    );

    expect(screen.getByRole("heading", { name: "En cours" })).toBeInTheDocument();
    expect(screen.getByText("Point d'équipe")).toBeInTheDocument();
    expect(screen.getByText("10:00 – 11:00")).toBeInTheDocument();
    expect(screen.getByText("Salle 2")).toBeInTheDocument();
  });

  it("groupe les événements par jour dans une vue de plusieurs jours", () => {
    const later = {
      calendarId: "c",
      uid: "later",
      title: "Déjeuner",
      allDay: false,
      location: "Bureau",
      start: { dateTime: "2026-11-14T09:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-14T10:00:00.000Z", timeZone: "UTC" },
    } as unknown as CalendarItem;

    render(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={{ ...agendaView, filter: { rangeDays: 7, includeAllDay: true } }}
        logicalDate="2026-11-12"
        locale="fr-FR"
        now={new Date("2026-11-12T08:00:00.000Z")}
        injectedItems={[later]}
      />,
    );

    expect(screen.getByRole("heading", { name: /14 novembre 2026/ })).toBeInTheDocument();
    expect(screen.getByText("Déjeuner")).toBeInTheDocument();
    expect(screen.getByText("09:00 – 10:00")).toBeInTheDocument();
    expect(screen.getByText("Bureau")).toBeInTheDocument();
  });

  it("marque aussi l'événement en cours dans une vue de plusieurs jours", () => {
    const ongoing = {
      calendarId: "c",
      uid: "ongoing-week",
      title: "R3.11 Droit contrats",
      allDay: false,
      location: "Amphi Olympes de Gouges",
      start: { dateTime: "2026-11-12T09:30:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-12T11:00:00.000Z", timeZone: "UTC" },
    } as unknown as CalendarItem;

    render(
      <CalendarWidget
        placement={{ ...placement, module: "agenda" }}
        view={{ ...agendaView, filter: { rangeDays: 7, includeAllDay: true } }}
        logicalDate="2026-11-12"
        locale="fr-FR"
        now={new Date("2026-11-12T10:00:00.000Z")}
        injectedItems={[ongoing]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Aujourd’hui" })).toBeInTheDocument();
    expect(screen.getByText("R3.11 Droit contrats")).toBeInTheDocument();
    expect(screen.getByText("09:30 – 11:00")).toBeInTheDocument();
    expect(screen.getByText("En cours")).toBeInTheDocument();
  });
});
