import type { DayState } from "@/lib/contracts/types";

export type IsoDateTime = string;
export type LocalDate = string;

export function toIso(instant: string | Date): string {
  return instant instanceof Date ? instant.toISOString() : instant;
}

/**
 * Journée logique : date civile locale de (instant - dayStartHour heures).
 * Une seule implémentation partagée par l'UI (TS) et par Rust (nommage).
 */
export function logicalDay(
  instant: string | Date,
  dayStartHour: number,
  timeZone: string,
): LocalDate {
  const date = new Date(toIso(instant));
  const shifted = new Date(date.getTime() - dayStartHour * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** Date civile `YYYY-MM-DD` dans le fuseau demandé. */
export function formatLocalDate(instant: string | Date, timeZone: string): LocalDate {
  const date = new Date(toIso(instant));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** Numéro du jour dans l'année (1-based), dans le fuseau demandé. */
export function dayOfYear(instant: string | Date, timeZone: string): number {
  const date = new Date(toIso(instant));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = Number(parts.find((p) => p.type === "year")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "month")?.value ?? "1");
  const d = Number(parts.find((p) => p.type === "day")?.value ?? "1");
  const start = Date.UTC(y, 0, 1);
  const current = Date.UTC(y, m - 1, d);
  return Math.floor((current - start) / 86_400_000) + 1;
}

export function isDayStarted(
  dayState: DayState | null,
  now: Date | string,
  dayStartHour: number,
  timeZone: string,
): boolean {
  if (!dayState?.started || !dayState?.lastDayStartedAt) return false;
  return dayState.logicalDay === logicalDay(now, dayStartHour, timeZone);
}

export function greetingFor(hour: number): string {
  if (hour < 5) return "Bonne nuit";
  if (hour < 12) return "Bonjour";
  if (hour < 18) return "Bon après-midi";
  if (hour < 22) return "Bonsoir";
  return "Bonne nuit";
}
