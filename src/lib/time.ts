import type { LocalDate, LocalTime } from "./contracts/types";

/**
 * Affichage date/heure locale. Aucune donnée métier n'est calculée ici :
 * la journée logique vit dans `day.ts`.
 */

export interface TimeZoneResolution {
  /** Fuseau effectivement utilisé (jamais invalide). */
  readonly timeZone: string;
  readonly valid: boolean;
  /** Message affichable si le fuseau demandé n'existe pas (jamais un décalage silencieux). */
  readonly warning: string | null;
}

const FALLBACK_TIME_ZONE = "UTC";

function isValidTimeZone(candidate: string): boolean {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(
  candidate: string | null | undefined,
  fallback: string = FALLBACK_TIME_ZONE,
): TimeZoneResolution {
  if (candidate && isValidTimeZone(candidate)) {
    return { timeZone: candidate, valid: true, warning: null };
  }
  const safeFallback = isValidTimeZone(fallback) ? fallback : FALLBACK_TIME_ZONE;
  return {
    timeZone: safeFallback,
    valid: false,
    warning: candidate
      ? `Fuseau horaire inconnu « ${candidate} » : affichage en ${safeFallback}.`
      : `Fuseau horaire indisponible : affichage en ${safeFallback}.`,
  };
}

/** Fuseau IANA de la machine (toujours résolu, repli UTC). */
export function systemTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

function partsIn(instant: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
}

function numericPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Composante « ${type} » illisible.`);
  return parsed;
}

export function hourInZone(instant: Date, timeZone: string): number {
  return numericPart(partsIn(instant, timeZone), "hour") % 24;
}

export function minuteInZone(instant: Date, timeZone: string): number {
  return numericPart(partsIn(instant, timeZone), "minute");
}

/** Heure locale `HH:mm` (24 h). */
export function formatClock(instant: Date, timeZone: string, locale = "fr-FR"): LocalTime {
  const formatted = new Intl.DateTimeFormat(locale, {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
  // Certaines locales insèrent des espaces insécables ou des suffixes : on
  // normalise uniquement la forme HH:mm attendue par le contrat.
  const match = formatted.match(/(\d{1,2})\s*[:hH]\s*(\d{2})/);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }
  return formatted;
}

/** Date civile `YYYY-MM-DD` telle qu'affichée dans le fuseau demandé (fuseau d'origine d'un événement). */
export function localDateInZone(instant: string | Date, timeZone: string): LocalDate {
  const date = new Date(instant);
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

/** Heure complète locale `HH:mm` (24 h) dans le fuseau demandé. */
export function localTimeInZone(
  instant: string | Date,
  timeZone: string,
  locale = "fr-FR",
): LocalTime {
  return formatClock(new Date(instant), timeZone, locale);
}

/**
 * Construit un instant absolu (Date) à partir d'une date civile `YYYY-MM-DD`,
 * d'une heure `HH:mm` et d'un fuseau IANA (ou UTC).
 */
export function parseZonedDateTime(dateStr: string, timeStr: string, timeZone = "UTC"): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const safeYear = y ?? 2026;
  const safeMonth = (m ?? 1) - 1;
  const safeDay = d ?? 1;
  const safeHour = hh ?? 0;
  const safeMinute = mm ?? 0;

  if (timeZone.toUpperCase() === "UTC") {
    return new Date(Date.UTC(safeYear, safeMonth, safeDay, safeHour, safeMinute, 0, 0));
  }

  const utcGuess = new Date(Date.UTC(safeYear, safeMonth, safeDay, safeHour, safeMinute, 0, 0));
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(utcGuess);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const inTzYear = get("year") || safeYear;
    const inTzMonth = (get("month") || safeMonth + 1) - 1;
    const inTzDay = get("day") || safeDay;
    let inTzHour = get("hour");
    if (inTzHour === 24) inTzHour = 0;
    const inTzMin = get("minute") || 0;
    const inTzAsUtc = Date.UTC(inTzYear, inTzMonth, inTzDay, inTzHour, inTzMin, 0, 0);
    const offset = inTzAsUtc - utcGuess.getTime();
    return new Date(utcGuess.getTime() - offset);
  } catch {
    return utcGuess;
  }
}

/** Date longue dans le fuseau demandé (« mardi 27 octobre 2026 »). */
export function formatLongDate(instant: Date, timeZone: string, locale = "fr-FR"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(instant);
}

/** Date longue d'une date civile `YYYY-MM-DD`, sans dérive de fuseau. */
export function formatLocalDateLong(localDate: LocalDate, locale = "fr-FR"): string {
  const [year, month, day] = localDate.split("-").map(Number);
  if (!year || !month || !day) return localDate;
  // Midi UTC : insensible aux décalages de fuseau lors du formatage.
  const safe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(safe);
}

/** Date courte `YYYY-MM-DD` telle qu'affichée dans les listes techniques. */
export function formatShortDate(instant: Date, timeZone: string, locale = "fr-FR"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(instant);
}
