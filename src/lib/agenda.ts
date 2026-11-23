import type {
  CalendarItem,
  CalendarStatus,
  EventTimePoint,
  IsoDateTime,
  LocalCalendarEvent,
  LocalDate,
  ReminderStatus,
} from "./contracts/types";

/** Périodes d'affichage de l'agenda (SPEC §4 — V1 : jour, semaine, mois). */
export type AgendaPeriod = "day" | "week" | "month";

export const AGENDA_PERIODS: readonly AgendaPeriod[] = ["day", "week", "month"];

export const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` + N jours. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Instant UTC (ms) de début d'un événement. */
export function eventStartInstant(item: CalendarItem): number | null {
  const start = item.start;
  if ("date" in start) {
    const [y, m, d] = start.date.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  }
  const parsed = Date.parse(start.dateTime);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Instant UTC (ms) de fin — **exclusif** comme `DTEND` (RFC 5545) / `DTEND;VALUE=DATE`. */
export function eventEndInstant(item: CalendarItem): number | null {
  const end = item.end;
  if ("date" in end) {
    const [y, m, d] = end.date.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  }
  const parsed = Date.parse(end.dateTime);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Fuseau d'affichage d'un événement (l'heure d'un allDay n'en a pas). */
export function eventTimeZone(item: CalendarItem): string {
  const start = item.start;
  if ("date" in start) return "UTC";
  return start.timeZone;
}

/** Décalage UTC (ms) du fuseau IANA à un instant donné. */
function zonedOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wallMs = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
  );
  return wallMs - instant;
}

/** Instant de début d'une journée civile dans un fuseau (bornes d'un jour logique). */
export function localDayStartInstant(date: LocalDate, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  return utcMidnight - zonedOffsetMs(utcMidnight, timeZone);
}

/**
 * Valeur `datetime-local` (`YYYY-MM-DDTHH:mm`) d'un instant, dans un fuseau.
 * Retourne une chaîne vide si l'instant est illisible.
 */
export function instantToLocalInput(instant: string | Date, timeZone: string): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(parsed);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const hour = value("hour");
  const minute = value("minute");
  if (!year || !month || !day || !hour || !minute) return "";
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Convertit une valeur `datetime-local` (heure murale dans `timeZone`) en
 * instant UTC RFC 3339. `null` si la valeur ne respecte pas le format attendu.
 *
 * L'offset du fuseau dépend de l'instant : on résout par deux passes, ce qui
 * couvre les changements d'heure usuels (une heure murale inexistante est
 * résolue vers l'instant le plus proche, sans jamais inventer d'offset fixe).
 */
export function localInputToInstant(input: string, timeZone: string): IsoDateTime | null {
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const wallMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  if (!Number.isFinite(wallMs)) return null;
  let instant = wallMs - zonedOffsetMs(wallMs, timeZone);
  instant = wallMs - zonedOffsetMs(instant, timeZone);
  if (!Number.isFinite(instant)) return null;
  return new Date(instant).toISOString();
}

/** Événement local persisté (écrivable), par opposition à une occurrence de flux. */
export function isLocalCalendarEvent(item: CalendarItem): item is LocalCalendarEvent {
  return "id" in item && typeof item.id === "string";
}

/** Identité stable d'un élément d'agenda (id local, ou occurrence de flux). */
export function calendarItemKey(item: CalendarItem): string {
  if (isLocalCalendarEvent(item)) return `local:${item.id}`;
  return `feed:${item.calendarId}:${item.uid}:${JSON.stringify(item.occurrenceStart)}`;
}

/** Libellé de tri secondaire quand deux événements commencent au même instant. */
function calendarItemSortId(item: CalendarItem): string {
  if (isLocalCalendarEvent(item)) return item.id;
  return `${item.calendarId}:${item.uid}:${JSON.stringify(item.occurrenceStart)}`;
}

/**
 * Indique si l'événement (local ou flux) tombe sur la journée civile `date`.
 *
 * Journée entière : plage `[start.date, end.date)` avec `end` exclusif.
 * Horaire : vraie intersection avec la journée — un événement commencé la
 * veille et terminé le lendemain est présent sur les deux jours.
 */
export function isEventOnDate(item: CalendarItem, date: LocalDate): boolean {
  const start = item.start;
  const end = item.end;
  if ("date" in start && "date" in end) {
    // Plage [start.date, end.date) avec `end` exclusif (un seul jour si start = fin - 1 jour).
    const lastDay = addDays(end.date, -1);
    const firstDay = start.date;
    if (firstDay > lastDay) return false;
    return firstDay <= date && date <= lastDay;
  }
  const startInstant = eventStartInstant(item);
  const endInstant = eventEndInstant(item);
  if (startInstant === null || endInstant === null) return false;
  const eventZone = eventTimeZone(item);
  const dayStart = localDayStartInstant(date, eventZone);
  const dayEnd = localDayStartInstant(addDays(date, 1), eventZone);
  // Fin exclusive : l'événement est actif si start < dayEnd && end > dayStart.
  return startInstant < dayEnd && endInstant > dayStart;
}

/**
 * Union des événements qui touchent au moins un jour de `[from, to]`,
 * dédupliquée puis triée par début croissant et identifiant.
 */
export function eventsInRange(
  items: readonly CalendarItem[],
  from: LocalDate,
  to: LocalDate,
): CalendarItem[] {
  const byKey = new Map<string, CalendarItem>();
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    for (const item of items) {
      if (isEventOnDate(item, cursor)) byKey.set(calendarItemKey(item), item);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const byStart = (eventStartInstant(left) ?? 0) - (eventStartInstant(right) ?? 0);
    if (byStart !== 0) return byStart;
    const leftId = calendarItemSortId(left);
    const rightId = calendarItemSortId(right);
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  });
}

/**
 * Ordre d'affichage d'une journée : journées entières d'abord, puis horaires
 * par heure de début, enfin identifiant pour rester déterministe.
 */
export function compareAgendaItems(left: CalendarItem, right: CalendarItem): number {
  const leftAllDay = "date" in left.start ? 0 : 1;
  const rightAllDay = "date" in right.start ? 0 : 1;
  if (leftAllDay !== rightAllDay) return leftAllDay - rightAllDay;
  const byStart = (eventStartInstant(left) ?? 0) - (eventStartInstant(right) ?? 0);
  if (byStart !== 0) return byStart;
  const leftId = calendarItemSortId(left);
  const rightId = calendarItemSortId(right);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

/** Événements visibles pour une journée (triés par début croissant). */
export function eventsOnDate(items: readonly CalendarItem[], date: LocalDate): CalendarItem[] {
  return items
    .filter((item) => isEventOnDate(item, date))
    .sort((a, b) => (eventStartInstant(a) ?? 0) - (eventStartInstant(b) ?? 0));
}

/** Période → fenêtre d'interrogation du backend (`from` inclus, `to` inclus). */
export function agendaRangeFor(
  period: AgendaPeriod,
  anchor: LocalDate,
  weekStartsOn: 0 | 1 | 6,
): { from: LocalDate; to: LocalDate } {
  if (period === "day") return { from: anchor, to: anchor };
  if (period === "week") {
    const start = weekStartFor(anchor, weekStartsOn);
    return { from: start, to: addDays(start, 6) };
  }
  const [year, month] = anchor.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  return { from: monthStart, to: monthEnd };
}

export function weekStartFor(date: LocalDate, weekStartsOn: 0 | 1 | 6): LocalDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const current = new Date(Date.UTC(year, month - 1, day));
  const weekday = (current.getUTCDay() + 6) % 7; // 0 = lundi
  const shift = (weekday - ((weekStartsOn + 6) % 7) + 7) % 7;
  const start = new Date(current.getTime() - shift * DAY_MS);
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, "0");
  const d = String(start.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Libellé français d'un statut d'événement. */
export function calendarStatusLabel(status: CalendarStatus): string {
  switch (status) {
    case "cancelled":
      return "Annulé";
    case "tentative":
      return "Tentative";
    default:
      return "Confirmé";
  }
}

/** Libellé français d'un statut de rappel. */
export function reminderStatusLabel(status: ReminderStatus): string {
  switch (status) {
    case "done":
      return "Terminé";
    case "cancelled":
      return "Annulé";
    default:
      return "À faire";
  }
}

/** Libellé d'échéance d'un rappel (date longue + heure, fuseau d'origine). */
export function reminderDueLabel(reminder: {
  dueDate: string | null;
  dueTime: string | null;
  dueTimeZone: string | null;
}): string | null {
  if (!reminder.dueDate) return null;
  const date = new Date(`${reminder.dueDate}T12:00:00.000Z`);
  const long = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const time = reminder.dueTime && reminder.dueTimeZone ? ` à ${reminder.dueTime}` : "";
  return `${long}${time}`;
}

export type { EventTimePoint };

/** Couleur et nom du calendrier abonné d'où vient un élément (rien pour un événement local). */
export function feedAccent(item: CalendarItem): { color: string | null; name: string | null } {
  if (isLocalCalendarEvent(item)) return { color: null, name: null };
  return { color: item.calendarColor ?? null, name: item.calendarName ?? null };
}
