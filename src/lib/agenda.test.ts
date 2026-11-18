import { describe, expect, it } from "vitest";
import {
  agendaRangeFor,
  compareAgendaItems,
  eventsInRange,
  isEventOnDate,
  isLocalCalendarEvent,
} from "./agenda";
import type { LocalCalendarEvent } from "./contracts/types";
import { keyWarnings } from "./warnings";

function event(overrides: Partial<LocalCalendarEvent> = {}): LocalCalendarEvent {
  return {
    id: "event-1",
    uid: "event-1@dayali.local",
    calendarId: "local",
    title: "Événement",
    description: null,
    location: null,
    allDay: true,
    start: { date: "2026-10-27" },
    end: { date: "2026-10-28" },
    projectId: null,
    machineId: "machine-test",
    createdAt: "2026-10-20T07:10:00.000Z",
    updatedAt: "2026-10-20T07:10:00.000Z",
    sequence: 0,
    status: "confirmed",
    ...overrides,
  };
}

describe("agenda — fenêtre et journée", () => {
  it("inclut le dernier jour du mois dans la fenêtre", () => {
    expect(agendaRangeFor("month", "2026-02-12", 1)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("écarte un événement entièrement hors de la fenêtre", () => {
    const later = event({
      id: "later",
      start: { date: "2026-11-10" },
      end: { date: "2026-11-11" },
    });

    expect(eventsInRange([later], "2026-10-27", "2026-10-28")).toEqual([]);
    expect(isEventOnDate(later, "2026-10-27")).toBe(false);
  });

  it("exclut la veille et le lendemain d'un événement journée entière", () => {
    const day = event();

    expect(isEventOnDate(day, "2026-10-26")).toBe(false);
    expect(isEventOnDate(day, "2026-10-27")).toBe(true);
    expect(isEventOnDate(day, "2026-10-28")).toBe(false);
  });

  it("ne duplique pas un événement multi-jours dans la fenêtre", () => {
    const multi = event({
      id: "multi",
      start: { date: "2026-10-27" },
      end: { date: "2026-10-30" },
    });

    const items = eventsInRange([multi], "2026-10-27", "2026-10-29");

    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first && isLocalCalendarEvent(first) ? first.id : null).toBe("multi");
  });

  it("présente un horaire à cheval sur minuit sur les deux jours", () => {
    const overnight = event({
      id: "overnight",
      allDay: false,
      start: { dateTime: "2026-10-27T21:30:00.000Z", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-28T01:00:00.000Z", timeZone: "Europe/Paris" },
    });

    expect(isEventOnDate(overnight, "2026-10-26")).toBe(false);
    expect(isEventOnDate(overnight, "2026-10-27")).toBe(true);
    expect(isEventOnDate(overnight, "2026-10-28")).toBe(true);
    expect(isEventOnDate(overnight, "2026-10-29")).toBe(false);
    expect(eventsInRange([overnight], "2026-10-27", "2026-10-28")).toHaveLength(1);
  });

  it("trie par début croissant puis identifiant", () => {
    const later = event({
      id: "c",
      allDay: false,
      start: { dateTime: "2026-10-28T08:00:00.000Z", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-28T09:00:00.000Z", timeZone: "Europe/Paris" },
    });
    const earlierB = event({
      id: "b",
      start: { date: "2026-10-27" },
    });
    const earlierA = event({
      id: "a",
      start: { date: "2026-10-27" },
    });

    const items = eventsInRange([later, earlierB, earlierA], "2026-10-27", "2026-10-28");

    expect(items.map((item) => (isLocalCalendarEvent(item) ? item.id : "feed"))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
  it("place les journées entières avant les horaires du même jour", () => {
    const allDay = event({ id: "all-day" });
    const timed = event({
      id: "timed",
      allDay: false,
      start: { dateTime: "2026-10-27T06:00:00.000Z", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-10-27T07:00:00.000Z", timeZone: "Europe/Paris" },
    });

    expect([timed, allDay].sort(compareAgendaItems)).toEqual([allDay, timed]);
  });
});

describe("keyWarnings", () => {
  it("conserve les doublons avec des clés distinctes et stables", () => {
    const keyed = keyWarnings([
      "fichier a illisible",
      "fichier b illisible",
      "fichier a illisible",
    ]);

    expect(keyed.map((entry) => entry.message)).toEqual([
      "fichier a illisible",
      "fichier b illisible",
      "fichier a illisible",
    ]);
    expect(new Set(keyed.map((entry) => entry.key)).size).toBe(3);
    expect(keyWarnings(["fichier a illisible"]).at(0)?.key).toBe(keyed.at(0)?.key);
  });
});
