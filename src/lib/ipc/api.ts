/**
 * Interface IPC consommée par l'UI. Les noms de commandes et les chargeurs sont
 * ceux de `docs/PLAN.md` §5.6 ; les arguments JS sont en camelCase (Tauri
 * convertit vers les paramètres `snake_case` de Rust).
 */

import type { ReminderReportInput } from "../contracts/end-of-day";
import type {
  CalendarFeed,
  CalendarListResult,
  Config,
  ConfigSnapshot,
  DayState,
  DeepPartial,
  FeedAddInput,
  FeedStatus,
  FileRef,
  LocalCalendarEvent,
  LocalDate,
  MachineLocal,
  Reminder,
  ReminderList,
  RemindersFilter,
  Sha256,
  VaultInfo,
} from "../contracts/types";

export type { ReminderReportInput } from "../contracts/end-of-day";

export interface VaultOpenInput {
  /** Chemin absolu local choisi par l'utilisateur. */
  readonly path: string;
}

export interface VaultCreateInput {
  /** Dossier dans lequel le sous-dossier du vault sera créé. */
  readonly parentPath: string;
  /** Nom du sous-dossier créé ; validé côté UI avant l'appel. */
  readonly name: string;
}

export interface ConfigPatchInput {
  readonly patch: DeepPartial<Config>;
  /** SHA-256 du `config.json` lu : jamais d'écriture sans précondition. */
  readonly expectedRevision: Sha256;
}

export interface DayStartInput {
  /** Instant RFC 3339 de l'action (horloge injectable). */
  readonly at: string;
}

/** Fenêtre d'interrogation de l'agenda (`from` inclus, `to` inclus). */
export interface CalendarListInput {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export interface CalendarSaveInput {
  readonly event: LocalCalendarEvent;
  /** SHA-256 de la version attendue ; jamais d'écriture sans précondition. */
  readonly expected?: Sha256;
}

export interface CalendarDeleteInput {
  readonly eventId: string;
  readonly expected: Sha256;
}

/** Lecture seule : hash courant du fichier d'un événement (précondition). */
export interface CalendarFileRefInput {
  readonly id: string;
}

export interface CalendarImportFeedInput {
  readonly feedId: string;
  readonly url: string;
}

export interface ReminderSaveInput {
  readonly reminder: Reminder;
  /** SHA-256 de la version attendue ; jamais d'écriture sans précondition. */
  readonly expected?: Sha256;
}

export interface ReminderDeleteInput {
  readonly id: string;
  readonly expected: Sha256;
}

/** Lecture seule : hash courant du fichier d'un rappel (précondition de suppression). */
export interface ReminderFileRefInput {
  readonly id: string;
}

export interface ReminderListSaveInput {
  readonly list: ReminderList;
  readonly expected?: Sha256;
}

export interface ReminderListDeleteInput {
  readonly id: string;
  readonly expected: Sha256;
}

/** Métadonnées d'une photo Unsplash : jamais de clé ni d'octets d'image. */
export interface HomePhoto {
  readonly id: string;
  readonly src: string;
  readonly credit: string;
  readonly username: string;
  readonly source: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly title?: string;
}

export interface HomePhotoInput {
  readonly logicalDate: LocalDate;
  readonly query: string | null;
}

export interface HomePhotoSeenInput {
  readonly id: string;
  readonly logicalDate: LocalDate;
}

export interface IpcApi {
  vaultOpen(input: VaultOpenInput): Promise<VaultInfo>;
  /** Crée `<parentPath>/<name>/` puis son `.dayali/`, sans jamais écraser l'existant. */
  vaultCreate(input: VaultCreateInput): Promise<VaultInfo>;
  vaultClose(): Promise<void>;

  configGet(): Promise<ConfigSnapshot>;
  configPatch(input: ConfigPatchInput): Promise<ConfigSnapshot>;
  /** Couleur d'accent du système (`#rrggbb`), `null` si la plateforme ne l'expose pas. */
  systemAccentColor(): Promise<string | null>;

  machineLocalGet(): Promise<MachineLocal>;

  dayStateGet(): Promise<DayState>;
  dayStart(input: DayStartInput): Promise<DayState>;
  dayMarkLateNightShown(input: DayStartInput): Promise<DayState>;

  // Module Agenda (étape (c)) : calendrier local (`calendar/*.ics`) + flux iCal en lecture seule.
  calendarList(input: CalendarListInput): Promise<CalendarListResult>;
  /** Lecture seule : référence du fichier pour obtenir le hash de précondition. */
  calendarFileRef(input: CalendarFileRefInput): Promise<FileRef>;
  calendarSave(input: CalendarSaveInput): Promise<LocalCalendarEvent>;
  calendarDelete(input: CalendarDeleteInput): Promise<void>;
  calendarImportFeed(input: CalendarImportFeedInput): Promise<FeedStatus>;
  // Calendriers abonnés par URL (lecture seule, propres à la machine).
  calendarFeedList(): Promise<CalendarFeed[]>;
  calendarFeedAdd(input: FeedAddInput): Promise<CalendarFeed>;
  calendarFeedRemove(input: { readonly feedId: string }): Promise<void>;
  calendarFeedRefresh(input?: { readonly feedId?: string }): Promise<CalendarFeed[]>;

  // Module Rappels (étape (c)) : listes multiples, « Ma journée », dates.
  reminderList(filter?: RemindersFilter): Promise<Reminder[]>;
  reminderListDefs(): Promise<ReminderList[]>;
  /** Lecture seule : référence du fichier pour obtenir le hash de précondition. */
  reminderFileRef(input: ReminderFileRefInput): Promise<FileRef>;
  reminderSave(input: ReminderSaveInput): Promise<Reminder>;
  reminderDelete(input: ReminderDeleteInput): Promise<void>;
  reminderListSave(input: ReminderListSaveInput): Promise<ReminderList>;
  reminderListDelete(input: ReminderListDeleteInput): Promise<void>;
  /** Journalise puis applique une décision de report, de replanification, abandon ou restauration. */
  reminderReport(input: ReminderReportInput): Promise<Reminder>;

  // Photo d'accueil Unsplash (mode en ligne optionnel). La clé de l'app reste en Rust.
  /** `null` sans clé ; l'UI garde alors la photo Wikimedia embarquée. */
  homePhotoUnsplash(input: HomePhotoInput): Promise<HomePhoto | null>;
  /**
   * Identifiants des photos déjà affichées, enregistrés dans le vault (toutes machines), du plus
   * ancien au plus récent : ils ne doivent jamais être reproposés.
   */
  homePhotoSeenList(): Promise<string[]>;
  /** Enregistre dans le vault qu'une photo a été affichée pendant cette journée logique. */
  homePhotoSeenRecord(input: HomePhotoSeenInput): Promise<void>;
}
