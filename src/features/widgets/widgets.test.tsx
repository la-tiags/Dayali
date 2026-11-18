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
      />,
    );
    expect(screen.getByText("Aucun événement sur cette période.")).toBeInTheDocument();
  });
});
