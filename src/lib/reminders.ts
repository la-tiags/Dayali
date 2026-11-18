import { addDays } from "./agenda";
import type { LocalDate, Reminder, RemindersFilter } from "./contracts/types";
import { parseZonedDateTime } from "./time";

/** « Ma journée » = filtre à échéances ≤ jour logique (retards inclus) ; `{}` ou `null` = tous les rappels. */
export function isMaJournee(filter: RemindersFilter | null | undefined): boolean {
  return filter?.dueWithinDays === 0;
}

/** Urgence d'un rappel : `today` (aujourd'hui ou en retard), `upcoming` (daté, plus tard) ou `someday` (sans échéance). */
export type ReminderUrgency = "today" | "upcoming" | "someday";

export function reminderUrgency(reminder: Reminder, logicalDay: LocalDate): ReminderUrgency {
  if (reminder.dueDate === null) return "someday";
  return reminder.dueDate <= logicalDay ? "today" : "upcoming";
}

const URGENCY_RANK: Readonly<Record<ReminderUrgency, number>> = {
  today: 0,
  upcoming: 1,
  someday: 2,
};

/**
 * Met en avant la journée : d'abord ce qui est dû aujourd'hui ou en retard, puis ce qui est
 * daté plus tard, puis ce qui n'a pas d'échéance. L'ordre d'entrée est conservé dans chaque groupe.
 */
export function prioritizeReminders<T extends Reminder>(
  items: readonly T[],
  logicalDay: LocalDate,
): T[] {
  return [...items].sort(
    (a, b) =>
      URGENCY_RANK[reminderUrgency(a, logicalDay)] - URGENCY_RANK[reminderUrgency(b, logicalDay)],
  );
}

/** Filtre d'une liste de rappels choisie par l'utilisateur. */
export function filterForList(listId: string): RemindersFilter {
  return { listIds: [listId] };
}

/** Filtre « Ma journée » (étape (c) : vue calculée, pas un fichier). */
export function filterForMaJournee(): RemindersFilter {
  return { statuses: ["open"], dueWithinDays: 0 };
}

/** Clé de tri effective : LexoRank (`sortKey`) ou, à défaut, échéance (date + heure). */
function effectiveSortKey(reminder: Reminder): string {
  if (reminder.sortKey) return reminder.sortKey;
  return `${reminder.dueDate ?? "9999-12-31"}T${reminder.dueTime ?? "00:00"}`;
}

/** Applique le filtre V1 (`listIds` | `statuses` | `dueWithinDays`) puis trie. */
export function applyRemindersFilter(
  items: readonly Reminder[],
  filter: RemindersFilter | null | undefined,
  logicalDay: LocalDate,
): Reminder[] {
  // `abandoned` reste dans le vault pour l'historique, mais n'est jamais une
  // vue opérationnelle (widget, accueil ou « Ma journée »).
  let next = items.filter((item) => item.status !== "abandoned");
  const listIds = filter?.listIds;
  if (listIds && listIds.length > 0) {
    next = next.filter((item) => listIds.includes(item.listId));
  }
  const statuses = filter?.statuses;
  if (statuses && statuses.length > 0) {
    next = next.filter((item) => statuses.includes(item.status));
  }
  const dueWithin = filter?.dueWithinDays;
  if (dueWithin !== undefined) {
    next = next.filter((item) => {
      if (item.dueDate === null) return false;
      if (item.dueDate > logicalDay) return false;
      if (dueWithin === 0) return true; // retards inclus
      const horizon = addDays(logicalDay, -(dueWithin - 1));
      return item.dueDate >= horizon;
    });
  }
  return [...next].sort(
    (a, b) =>
      effectiveSortKey(a).localeCompare(effectiveSortKey(b)) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * Un rappel ouvert est-il en retard par rapport au jour logique courant ?
 * Si `now` est fourni et que le rappel a une heure d'échéance aujourd'hui,
 * l'heure et le fuseau sont rigoureusement pris en compte.
 */
export function isOverdue(
  reminder: Reminder,
  logicalDay: LocalDate,
  now?: Date | string,
  timeZone?: string,
): boolean {
  if (reminder.status !== "open" || reminder.dueDate === null) return false;
  if (reminder.dueDate < logicalDay) return true;
  if (reminder.dueDate > logicalDay) return false;

  // Échéance le jour même
  if (reminder.dueTime && now !== undefined) {
    const current = typeof now === "string" ? new Date(now) : now;
    const dueInstant = parseZonedDateTime(
      reminder.dueDate,
      reminder.dueTime,
      reminder.dueTimeZone ?? timeZone ?? "UTC",
    );
    return current.getTime() > dueInstant.getTime();
  }

  return false;
}

/** Nombre de rappels à traiter pour la journée logique (ouverts, échéance ≤ jour). */
export function countDueToday(items: readonly Reminder[], logicalDay: LocalDate): number {
  return items.filter(
    (item) => item.status === "open" && item.dueDate !== null && item.dueDate <= logicalDay,
  ).length;
}

/** Bascule d'un rappel ouvert/terminé (cocher). `completedAt` est posé pour un passage à `done`. */
export function toggleReminderStatus(
  reminder: Reminder,
  status: "open" | "done" | "cancelled",
  completedAt: string,
): Reminder {
  if (status === "done") {
    return { ...reminder, status, completedAt };
  }
  if (status === "cancelled") {
    return { ...reminder, status, completedAt: null };
  }
  return { ...reminder, status, completedAt: null };
}
