import type { AgendaFilter, RemindersFilter, SavedView } from "../../lib/contracts/types";

export type ViewAdapterResult<T> =
  | { readonly kind: "ready"; readonly filter: T }
  | { readonly kind: "incompatible"; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown, maxItems: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function isStatusArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    new Set(value).size === value.length &&
    value.every((item) => item === "open" || item === "done" || item === "cancelled")
  );
}

export function remindersView(view: SavedView | undefined): ViewAdapterResult<RemindersFilter> {
  if (!view) return { kind: "incompatible", message: "Vue absente : le widget est désactivé." };
  if (view.module !== "reminders" || !isRecord(view.filter))
    return { kind: "incompatible", message: "Vue incompatible avec le module Rappels." };
  const filter = view.filter;
  const allowed = new Set(["listIds", "statuses", "dueWithinDays", "projectIds"]);
  if (Object.keys(filter).some((key) => !allowed.has(key)))
    return { kind: "incompatible", message: "Filtre de vue Rappels incompatible." };
  if (filter.listIds !== undefined && !isStringArray(filter.listIds, 50))
    return { kind: "incompatible", message: "Filtre de listes Rappels invalide." };
  if (filter.projectIds !== undefined && !isStringArray(filter.projectIds, 50))
    return { kind: "incompatible", message: "Filtre de projets Rappels invalide." };
  if (filter.statuses !== undefined && !isStatusArray(filter.statuses))
    return { kind: "incompatible", message: "Filtre d'états Rappels invalide." };
  if (
    filter.dueWithinDays !== undefined &&
    (typeof filter.dueWithinDays !== "number" ||
      !Number.isInteger(filter.dueWithinDays) ||
      filter.dueWithinDays < 0 ||
      filter.dueWithinDays > 365)
  )
    return { kind: "incompatible", message: "Filtre de dates Rappels invalide." };
  return { kind: "ready", filter: filter as RemindersFilter };
}

export function calendarView(view: SavedView | undefined): ViewAdapterResult<AgendaFilter> {
  if (!view) return { kind: "incompatible", message: "Vue absente : le widget est désactivé." };
  if (view.module !== "agenda" || !isRecord(view.filter))
    return { kind: "incompatible", message: "Vue incompatible avec le module Agenda." };
  const filter = view.filter;
  const allowed = new Set(["rangeDays", "includeAllDay", "projectIds"]);
  if (Object.keys(filter).some((key) => !allowed.has(key)))
    return { kind: "incompatible", message: "Filtre de vue Agenda incompatible." };
  if (
    filter.rangeDays !== undefined &&
    (typeof filter.rangeDays !== "number" ||
      !Number.isInteger(filter.rangeDays) ||
      filter.rangeDays < 1 ||
      filter.rangeDays > 62)
  )
    return { kind: "incompatible", message: "Filtre de dates Agenda invalide." };
  if (filter.includeAllDay !== undefined && typeof filter.includeAllDay !== "boolean")
    return { kind: "incompatible", message: "Filtre toute la journée Agenda invalide." };
  if (filter.projectIds !== undefined && !isStringArray(filter.projectIds, 50))
    return { kind: "incompatible", message: "Filtre de projets Agenda invalide." };
  return { kind: "ready", filter: filter as AgendaFilter };
}
