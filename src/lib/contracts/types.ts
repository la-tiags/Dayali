/**
 * Contrats TypeScript consommés par l'UI à l'étape (a).
 *
 * TODO(a) : ces types sont des **types minimaux locaux** en attendant les schémas
 * Zod générés (`src/lib/schemas/generated/`, produits par
 * `scripts/generate-contracts.mjs` depuis `docs/schemas/*.schema.json`, cf.
 * docs/PLAN.md §1.8 et §5.10). Dès que les fichiers générés existent, remplacer :
 *
 *   export type Config = z.infer<typeof configSchema>;
 *   export type MachineFile = z.infer<typeof machineSchema>;
 *   export type MachineLocal = z.infer<typeof machineLocalSchema>;
 *
 * Aucun de ces types n'est une seconde source de vérité : ils décrivent
 * uniquement les champs lus/écrits par l'écran d'accueil de l'étape (a).
 */

import type { ReminderHistoryEntry } from "./end-of-day";

export type IsoDateTime = string; // UTC RFC 3339, ex. 2026-10-26T21:42:00.000Z
export type LocalDate = string; // YYYY-MM-DD
export type LocalTime = string; // HH:mm
export type MachineId = string; // UUIDv7
export type Sha256 = string; // 64 hex minuscules

export type Module = "agenda" | "reminders" | "journal" | "projects";

export interface VaultInfo {
  /** Chemin absolu local du vault. */
  readonly root: string;
  readonly name: string;
  readonly machineId: MachineId;
  readonly configRevision: Sha256;
}

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetPlacement {
  readonly id: string;
  readonly module: Module;
  readonly viewId: string;
  readonly title?: string;
  readonly layout: WidgetLayout;
  readonly enabled: boolean;
}

export interface SavedView {
  readonly id: string;
  readonly module: Module;
  readonly name: string;
  readonly icon?: string;
  readonly origin: "user" | "widget";
  readonly filter: Record<string, unknown>;
  readonly sort?: { field: string; direction: "asc" | "desc" };
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

/**
 * Sous-ensemble de `.dayali/config.json` (schéma canonique :
 * `docs/schemas/config.schema.json`). Les autres champs existent sur disque et
 * arriveront avec le contrat généré : l'UI de (a) ne les lit pas.
 */
export interface Config {
  readonly schemaVersion: number;
  readonly dayStartHour: number;
  readonly openDashboardOnLaunch: boolean;
  readonly locale: string;
  readonly weekStartsOn: 0 | 1 | 6;
  readonly dashboard: {
    readonly columns: 12;
    readonly rowHeight: number;
    readonly widgets: WidgetPlacement[];
  };
  readonly views: SavedView[];
  readonly quotes?: {
    readonly mode?: "api-preferred" | "bundled-only" | "custom-only";
    readonly api?: { readonly provider?: "none" | "wikiquote" };
    readonly refreshHour?: number;
    readonly includeCustom?: boolean;
    readonly pinnedIds?: readonly string[];
  };
  readonly notifications?: {
    readonly lateNight?: { readonly enabled?: boolean; readonly afterHour?: number };
    readonly dueReminders?: { readonly enabled?: boolean };
  };
  readonly appearance: {
    readonly greeting: { variants: boolean };
    readonly homeImage?: {
      readonly mode?: "bundled" | "folder" | "unsplash";
      readonly unsplashQuery?: string | null;
      readonly showCredit?: boolean;
      readonly dim?: number;
    };
  };
}

/** `.dayali/machines/<machineId>.json` — état local, jamais dans `config.json`. */
export interface LocalState {
  readonly lastDayStartDate: LocalDate | null;
  readonly lastDayStartedAt: IsoDateTime | null;
  readonly lateNightShownFor: LocalDate | null;
  readonly reminderHistory: readonly ReminderHistoryEntry[];
  readonly homeImageFolder: string | null;
  readonly lastFullScanAt: IsoDateTime | null;
}

/** TODO(a) : remplacer par `z.infer<typeof machineSchema>`. */
export interface MachineFile {
  readonly schemaVersion: number;
  readonly machineId: MachineId;
  readonly name: string;
  readonly localState: LocalState;
}

/** `machine.json` HORS vault (schéma `machine-local`). */
export interface MachineLocal {
  readonly schemaVersion: number;
  readonly machineId: MachineId;
  readonly createdAt: IsoDateTime;
  readonly lastVaultPath: string | null;
  readonly recentVaults: readonly string[];
}

/**
 * Référence d'un fichier du vault (docs/PLAN.md §5.1). Utilisée pour les
 * préconditions : `hash` est la version attendue, jamais une révision de config.
 */
export interface FileRef {
  readonly relPath: string;
  readonly hash: Sha256;
  readonly size: number;
  readonly mtime: IsoDateTime;
}

export interface ConfigSnapshot {
  readonly config: Config;
  readonly revision: Sha256;
  /** Chemin relatif d'une copie `.conflict-*`, si une divergence a eu lieu. */
  readonly conflictCopy: string | null;
}

/** Statut d'un flux iCal externe (lecture seule, cache hors vault). */
export interface FeedStatus {
  readonly feedId: string;
  readonly url: string;
  readonly lastFetchedAt: IsoDateTime | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly eventsCount: number;
  readonly error: string | null;
}

export interface DayState {
  readonly logicalDay: LocalDate;
  readonly dayStartHour: number;
  readonly started: boolean;
  readonly lastDayStartedAt: IsoDateTime | null;
  readonly lateNightShownFor: LocalDate | null;
  readonly carryOverCandidates: readonly Reminder[];
  /**
   * Avertissements de lecture des rappels : un fichier illisible est ignoré
   * pour le calcul des reports, jamais réécrit ni supprimé, et signalé ici.
   * Recalculés à la lecture, jamais persistés ; vide si tout est lisible.
   */
  readonly carryOverWarnings: readonly string[];
}

/**
 * Point temporel d'un événement : journée entière (`date`, sans heure ni UTC,
 * `end` exclusif comme `DTEND;VALUE=DATE`) ou horaire (`dateTime` en UTC + fuseau
 * d'origine IANA). Discriminé union : `date` présent ⇔ événement toute la journée.
 */
export type EventTimePoint =
  | { readonly date: LocalDate }
  | { readonly dateTime: IsoDateTime; readonly timeZone: string };

/** État d'un événement local (`calendar/<eventId>.ics`) — modèle interne persisté. */
export interface LocalCalendarEvent {
  readonly id: string;
  readonly uid: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly allDay: boolean;
  readonly start: EventTimePoint;
  readonly end: EventTimePoint;
  readonly projectId: string | null;
  readonly machineId: string | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly sequence: number;
  readonly status: CalendarStatus;
}

export type CalendarStatus = "confirmed" | "tentative" | "cancelled";

/**
 * Occurrence éphémère d'un flux iCal externe (cache hors vault, jamais persistée).
 * Jamais validée par `calendar-event.schema.json` ; `calendar_save` la refuse.
 */
export interface FeedOccurrence {
  readonly calendarId: string;
  readonly uid: string;
  readonly seriesUid: string;
  readonly occurrenceStart: IsoDateTime | LocalDate;
  readonly isRecurring: boolean;
  readonly readOnly: true;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly allDay: boolean;
  readonly start: EventTimePoint;
  readonly end: EventTimePoint;
  readonly status: CalendarStatus;
  readonly projectId: string | null;
}

/** Type d'affichage commun Agenda : local (écrivable) ou flux (lecture seule). */
export type CalendarItem = LocalCalendarEvent | FeedOccurrence;

/**
 * Résultat de `calendar_list` : événements de la fenêtre demandée et
 * avertissements sur les fichiers ignorés à la lecture (jamais réécrits).
 */
export interface CalendarListResult {
  readonly items: readonly CalendarItem[];
  readonly warnings: readonly string[];
}

/** Statut d'un rappel (`open` | `done` | `cancelled`). */
export type ReminderStatus = "open" | "done" | "cancelled" | "abandoned";

/**
 * Récurrence — réservée V2 (le writer V1 persiste toujours `null`). Le reader
 * tolère un objet ; aucune occurrence n'est générée en V1.
 */
export interface ReminderRecurrence {
  readonly frequency: "daily" | "weekly" | "monthly" | "yearly";
  readonly interval: number;
  readonly weekdays: readonly number[];
  readonly untilDate: LocalDate | null;
  readonly count: number | null;
  readonly timeZone: string;
}

/** Rappel persisté (`reminders/<reminderId>.json`). */
export interface Reminder {
  readonly schemaVersion: number;
  readonly id: string;
  readonly listId: string;
  readonly title: string;
  readonly notes: string | null;
  readonly status: ReminderStatus;
  readonly dueDate: LocalDate | null;
  readonly dueTime: LocalTime | null;
  readonly dueTimeZone: string | null;
  readonly projectId: string | null;
  readonly completedAt: IsoDateTime | null;
  readonly abandonedAt?: IsoDateTime | null;
  readonly priority?: "low" | "medium" | "high" | null;
  readonly recurrence: ReminderRecurrence | null;
  readonly sortKey: string | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly machineId: string;
}

/** Liste de rappels (`reminders/lists/<listId>.json`). « Ma journée » n'est pas une liste stockée. */
export interface ReminderList {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly order: number;
  readonly archived: boolean;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly machineId: string;
}

/**
 * Filtre de rappels V1 (défini par une vue enregistrée ou par « Ma journée »).
 * `dueWithinDays: 0` = échéances ≤ jour logique courant, retards inclus.
 */
export interface RemindersFilter {
  readonly statuses?: readonly ReminderStatus[];
  readonly listIds?: readonly string[];
  readonly dueWithinDays?: number;
}

export interface AgendaFilter {
  readonly rangeDays?: number;
  readonly includeAllDay?: boolean;
  readonly projectIds?: readonly string[];
}

/** Statut du module Agenda / Rappels (chargement, succès, vide, erreur). */
export type ModuleStatus = "idle" | "loading" | "ready" | "error";

/** Contrat fin de journée partagé avec Rust et l'adaptateur IPC. */
export type {
  ReminderHistoryEntry,
  ReminderHistoryStatus,
  ReportAction,
} from "./end-of-day";

/**
 * Patch partiel de `Config`. Les tableaux sont remplacés en bloc (cf.
 * docs/PLAN.md §5.4) : ils ne sont jamais fusionnés élément par élément.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};
