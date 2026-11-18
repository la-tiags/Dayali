import { addDays, eventsInRange } from "../agenda";
import { MOCK_DEFAULT_CONFIG } from "../contracts/defaults";
import type {
  CalendarListResult,
  Config,
  ConfigSnapshot,
  DayState,
  EventTimePoint,
  FeedStatus,
  FileRef,
  LocalCalendarEvent,
  LocalDate,
  LocalState,
  MachineLocal,
  Reminder,
  ReminderHistoryEntry,
  ReminderList,
  RemindersFilter,
  Sha256,
  VaultInfo,
} from "../contracts/types";
import { formatLocalDate, logicalDay } from "../day";
import { baseName, joinPath, validateVaultName } from "../paths";
import { applyRemindersFilter } from "../reminders";
import { systemTimeZone } from "../time";
import type {
  CalendarListInput,
  ConfigPatchInput,
  DayStartInput,
  IpcApi,
  ReminderReportInput,
  VaultCreateInput,
  VaultOpenInput,
} from "./api";
import { IpcError } from "./errors";

/**
 * Mock IPC du navigateur (dev sans Tauri, tests, Playwright).
 *
 * Il ne remplace pas les garanties Rust : il reproduit les contrats observables
 * par l'UI — préconditions de révision, journée logique par machine,
 * `recentVaults` hors vault (étape (a)) et modules Agenda/Rappels (étape (c)).
 */

const MAX_RECENT_VAULTS = 10;
const MACHINE_ID = "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b";

interface MockVault {
  info: VaultInfo;
  config: Config;
  revision: Sha256;
  localState: LocalState & { reminderHistory: ReminderHistoryEntry[] };
  conflictCopy: string | null;
}

export interface MockIpcOptions {
  readonly now?: () => Date;
  readonly timeZone?: string;
  readonly machineLocal?: MachineLocal;
  readonly config?: Config;
  /** Copies de conflit déjà présentes (pour vérifier qu'on ne les masque jamais). */
  readonly conflictCopy?: string | null;
  /**
   * Avertissements de lecture de rappels injectés (fichier corrompu simulé).
   * `day_state` les renvoie tels quels ; le mock ne modifie aucune donnée.
   */
  readonly dayStateWarnings?: readonly string[];
  /** Données module injectées (agenda local, rappels, listes, flux). */
  readonly moduleData?: MockModuleData;
  /** Chemin de vault initial à créer et ouvrir automatiquement. */
  readonly initialVaultPath?: string;
}

export interface MockModuleData {
  readonly reminders?: readonly Reminder[];
  readonly lists?: readonly ReminderList[];
  readonly calendarEvents?: readonly LocalCalendarEvent[];
  readonly feeds?: readonly FeedStatus[];
  /** Fichiers d'agenda ignorés à la lecture (injectés pour les tests d'UI). */
  readonly calendarWarnings?: readonly string[];
}

export interface MockIpc extends IpcApi {
  /** État courant, pour les tests : vaults connus et chemin actif. */
  readonly inspect: () => { activeVaultPath: string | null; vaultPaths: string[] };
}

/** Hash purement local (FNV-1a étendu) : le vrai SHA-256 est calculé en Rust. */
function mockRevision(text: string): Sha256 {
  let hash = 0x811c9dc5;
  let output = "";
  for (let round = 0; round < 8; round += 1) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index) + round;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    output += hash.toString(16).padStart(8, "0");
  }
  return output.slice(0, 64);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch as T;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return merged as T;
}

function defaultLocalState(): LocalState {
  return {
    lastDayStartDate: null,
    lastDayStartedAt: null,
    lateNightShownFor: null,
    reminderHistory: [],
    homeImageFolder: null,
    lastFullScanAt: null,
  };
}

function defaultMachineLocal(): MachineLocal {
  return {
    schemaVersion: 1,
    machineId: MACHINE_ID,
    createdAt: "2026-10-20T07:05:00.000Z",
    lastVaultPath: null,
    recentVaults: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Référence factice mais déterministe : le même rappel (même contenu, même
 * `updatedAt`) produit toujours le même hash. Le vrai SHA-256 est calculé en Rust.
 */
function reminderHash(reminder: Reminder): Sha256 {
  return mockRevision(JSON.stringify(reminder));
}

function reminderRef(reminder: Reminder, hash: Sha256 = reminderHash(reminder)): FileRef {
  const text = JSON.stringify(reminder);
  return {
    relPath: `reminders/${reminder.id}.json`,
    hash,
    size: new TextEncoder().encode(text).length,
    mtime: reminder.updatedAt,
  };
}

/** Hash déterministe d'un événement, comme le SHA-256 du fichier `.ics` en Rust. */
function calendarEventHash(event: LocalCalendarEvent): Sha256 {
  return mockRevision(JSON.stringify(event));
}

/** Ramène un horodatage à la seconde, précision réellement écrite dans un `.ics`. */
function truncateToSecond(value: string): string {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return value;
  return new Date(Math.floor(instant / 1000) * 1000).toISOString();
}

function truncateTimePoint(point: EventTimePoint): EventTimePoint {
  return "date" in point ? point : { ...point, dateTime: truncateToSecond(point.dateTime) };
}

/**
 * Version telle qu'elle est relue depuis le fichier `.ics` : `machineId` n'est
 * pas persisté et les horodatages perdent leurs millisecondes. Le mock doit
 * reproduire cet écart, sinon il masque un faux conflit après sauvegarde.
 */
function persistedCalendarEvent(event: LocalCalendarEvent): LocalCalendarEvent {
  return {
    ...event,
    machineId: null,
    createdAt: truncateToSecond(event.createdAt),
    updatedAt: truncateToSecond(event.updatedAt),
    start: truncateTimePoint(event.start),
    end: truncateTimePoint(event.end),
  };
}

function calendarEventRef(event: LocalCalendarEvent): FileRef {
  const text = JSON.stringify(event);
  return {
    relPath: `calendar/${event.id}.ics`,
    hash: calendarEventHash(event),
    size: new TextEncoder().encode(text).length,
    mtime: event.updatedAt,
  };
}

/** Entrée d'historique minimale nécessaire au calcul des restes (lecture tolérante). */
function isCarryOverFor(value: unknown, reminderId: string, sourceDay: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return entry.reminderId === reminderId && entry.sourceDay === sourceDay;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Même tri que `services::reminders::list` : `dueDate` nulle en dernier, puis
 * `dueTime`, puis `createdAt`, puis `id`.
 */
function compareReminders(left: Reminder, right: Reminder): number {
  const leftNoDue = left.dueDate === null ? 1 : 0;
  const rightNoDue = right.dueDate === null ? 1 : 0;
  if (leftNoDue !== rightNoDue) return leftNoDue - rightNoDue;
  return (
    compareText(left.dueDate ?? "", right.dueDate ?? "") ||
    compareText(left.dueTime ?? "", right.dueTime ?? "") ||
    compareText(left.createdAt, right.createdAt) ||
    compareText(left.id, right.id)
  );
}

/**
 * Restes non traités pour la veille logique (PLAN §4.2, SPEC §6) : rappels
 * ouverts, échéance ≤ veille, sans entrée `carryOvers` pour ce rappel et cette
 * `sourceDay`. Reproduit exactement la règle Rust de `machine.rs`.
 */
function carryOverCandidates(
  reminders: readonly Reminder[],
  localState: LocalState,
  logical: LocalDate,
): Reminder[] {
  const sourceDay = addDays(logical, -1);
  return reminders
    .filter(
      (reminder) =>
        reminder.status === "open" && reminder.dueDate !== null && reminder.dueDate <= sourceDay,
    )
    .filter(
      (reminder) =>
        !localState.reminderHistory.some((entry) => isCarryOverFor(entry, reminder.id, sourceDay)),
    )
    .slice()
    .sort(compareReminders)
    .map((reminder) => clone(reminder));
}

export function createMockIpc(options: MockIpcOptions = {}): MockIpc {
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? systemTimeZone();
  let machineLocal: MachineLocal = clone(options.machineLocal ?? defaultMachineLocal());
  const vaults = new Map<string, MockVault>();
  let activeVaultPath: string | null = null;
  let reminders: Reminder[] = [...(options.moduleData?.reminders ?? [])];
  let lists: ReminderList[] = [...(options.moduleData?.lists ?? [])];
  let events: LocalCalendarEvent[] = [...(options.moduleData?.calendarEvents ?? [])];
  let feeds: FeedStatus[] = [...(options.moduleData?.feeds ?? [])];
  const reminderHistory = new Map<
    string,
    { status: "pending" | "applied"; action: ReminderReportInput["action"] }
  >();
  // Hash stable par rappel, comme le fichier sur disque : seules les écritures
  // du mock le font avancer, une relecture ne change jamais la version.
  const reminderHashes = new Map<string, Sha256>(
    reminders.map((reminder) => [reminder.id, reminderHash(reminder)]),
  );
  // Même principe pour les événements : le hash de précondition ne change
  // qu'à l'écriture, jamais à la lecture.
  const eventHashes = new Map<string, Sha256>(
    events.map((event) => [event.id, calendarEventHash(event)]),
  );
  // Même principe pour les listes : le hash de précondition n'avance qu'à
  // l'écriture, jamais à la lecture (comme le fichier sur disque).
  const listHashes = new Map<string, Sha256>(
    lists.map((list) => [list.id, mockRevision(JSON.stringify(list))]),
  );

  function requireVault(): MockVault {
    const vault = activeVaultPath ? vaults.get(activeVaultPath) : undefined;
    if (!vault) throw new IpcError("E_VAULT_NOT_OPEN");
    return vault;
  }

  function dayStateAt(vault: MockVault, instant: Date): DayState {
    const logical = logicalDay(instant, vault.config.dayStartHour, timeZone);
    return {
      logicalDay: logical,
      dayStartHour: vault.config.dayStartHour,
      started: vault.localState.lastDayStartDate === logical,
      lastDayStartedAt: vault.localState.lastDayStartedAt,
      lateNightShownFor: vault.localState.lateNightShownFor,
      carryOverCandidates: carryOverCandidates(reminders, vault.localState, logical),
      carryOverWarnings: [...(options.dayStateWarnings ?? [])],
    };
  }

  function snapshotFor(vault: MockVault): ConfigSnapshot {
    return {
      config: clone(vault.config),
      revision: vault.revision,
      conflictCopy: vault.conflictCopy,
    };
  }

  function touch(vault: MockVault): void {
    vault.info = { ...vault.info, configRevision: vault.revision };
  }

  function createVault(path: string): MockVault {
    const name = baseName(path);
    const config = clone(options.config ?? MOCK_DEFAULT_CONFIG);
    const localState = {
      ...defaultLocalState(),
      reminderHistory: [...defaultLocalState().reminderHistory],
    };
    const revision = mockRevision(JSON.stringify(config));
    const vault: MockVault = {
      info: { root: path, name, machineId: machineLocal.machineId, configRevision: revision },
      config,
      revision,
      localState,
      conflictCopy: options.conflictCopy ?? null,
    };
    vaults.set(path, vault);
    return vault;
  }

  function rememberVault(path: string): void {
    const recent = [path, ...machineLocal.recentVaults.filter((entry) => entry !== path)].slice(
      0,
      MAX_RECENT_VAULTS,
    );
    machineLocal = { ...machineLocal, lastVaultPath: path, recentVaults: recent };
  }

  if (options.initialVaultPath) {
    createVault(options.initialVaultPath);
    activeVaultPath = options.initialVaultPath;
    rememberVault(options.initialVaultPath);
  }

  return {
    inspect: () => ({ activeVaultPath, vaultPaths: [...vaults.keys()] }),

    async vaultOpen(input: VaultOpenInput): Promise<VaultInfo> {
      const path = input.path.trim();
      if (!path) throw new IpcError("E_NOT_FOUND", "Aucun dossier sélectionné.");
      const vault = vaults.get(path) ?? createVault(path);
      activeVaultPath = path;
      rememberVault(path);
      reminderHistory.clear();
      for (const entry of vault.localState.reminderHistory) {
        if (entry.status === "pending") {
          const reminder = reminders.find((item) => item.id === entry.reminderId);
          if (reminder) {
            const next: Reminder =
              entry.action === "abandon"
                ? {
                    ...reminder,
                    status: "abandoned",
                    abandonedAt: reminder.abandonedAt ?? new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  }
                : entry.action === "restore"
                  ? {
                      ...reminder,
                      status: "open",
                      abandonedAt: null,
                      updatedAt: new Date().toISOString(),
                    }
                  : {
                      ...reminder,
                      dueDate: entry.newDueDate ?? reminder.dueDate,
                      updatedAt: new Date().toISOString(),
                    };
            const index = reminders.findIndex((item) => item.id === reminder.id);
            if (index >= 0) {
              reminders[index] = { ...next, updatedAt: new Date().toISOString() };
              reminderHashes.set(reminder.id, reminderHash(reminders[index]));
            }
          }
          vault.localState.reminderHistory = vault.localState.reminderHistory.map((e) =>
            e.id === entry.id
              ? {
                  ...e,
                  status: "applied" as const,
                  resolvedAt: e.resolvedAt ?? new Date().toISOString(),
                }
              : e,
          );
        }
      }
      for (const entry of vault.localState.reminderHistory) {
        const key = `${entry.reminderId}:${entry.action}:${entry.logicalDay}`;
        reminderHistory.set(key, { status: entry.status, action: entry.action });
      }
      return clone(vault.info);
    },

    async vaultCreate(input: VaultCreateInput): Promise<VaultInfo> {
      const parentPath = input.parentPath.trim();
      if (!parentPath) throw new IpcError("E_NOT_FOUND", "Aucun dossier parent sélectionné.");
      const invalid = validateVaultName(input.name);
      if (invalid) {
        throw new IpcError("E_SCHEMA_INVALID", invalid, { details: { field: "name" } });
      }
      const path = joinPath(parentPath, input.name);
      // Le mock ne lit pas le disque : seul un vault déjà connu peut simuler un
      // dossier existant non vide, avec le même contrat que Rust.
      if (vaults.has(path)) {
        throw new IpcError(
          "E_PRECONDITION_FAILED",
          `Le dossier « ${path} » existe déjà et n'est pas vide.`,
          { details: { reason: "not_empty", path } },
        );
      }
      const vault = createVault(path);
      activeVaultPath = path;
      rememberVault(path);
      return clone(vault.info);
    },

    async vaultClose(): Promise<void> {
      activeVaultPath = null;
    },

    async configGet(): Promise<ConfigSnapshot> {
      return clone(snapshotFor(requireVault()));
    },

    async configPatch(input: ConfigPatchInput): Promise<ConfigSnapshot> {
      const vault = requireVault();
      if (input.expectedRevision !== vault.revision) {
        throw new IpcError("E_PRECONDITION_FAILED", undefined, {
          details: { currentRevision: vault.revision },
        });
      }
      const next = deepMerge(vault.config, input.patch);
      vault.config = {
        ...next,
        dashboard: { ...next.dashboard, widgets: clone(next.dashboard.widgets) },
        views: clone(next.views),
      };
      vault.revision = mockRevision(JSON.stringify(vault.config));
      touch(vault);
      return clone(snapshotFor(vault));
    },

    async machineLocalGet(): Promise<MachineLocal> {
      return clone(machineLocal);
    },

    async dayStateGet(): Promise<DayState> {
      return dayStateAt(requireVault(), now());
    },

    async dayStart(input: DayStartInput): Promise<DayState> {
      const vault = requireVault();
      const at = new Date(input.at);
      if (Number.isNaN(at.getTime())) throw new IpcError("E_INTERNAL", "Instant invalide.");
      const logical = logicalDay(at, vault.config.dayStartHour, timeZone);
      if (vault.localState.lastDayStartDate === logical) {
        return dayStateAt(vault, at);
      }
      vault.localState = {
        ...vault.localState,
        lastDayStartDate: logical,
        lastDayStartedAt: at.toISOString(),
      };
      return dayStateAt(vault, at);
    },

    async dayMarkLateNightShown(input: DayStartInput): Promise<DayState> {
      const vault = requireVault();
      const at = new Date(input.at);
      if (Number.isNaN(at.getTime())) throw new IpcError("E_INTERNAL", "Instant invalide.");
      vault.localState = {
        ...vault.localState,
        lateNightShownFor: logicalDay(at, vault.config.dayStartHour, timeZone),
      };
      return dayStateAt(vault, at);
    },

    async calendarList(input: CalendarListInput): Promise<CalendarListResult> {
      return {
        items: eventsInRange(events, input.from, input.to),
        warnings: [...(options.moduleData?.calendarWarnings ?? [])],
      };
    },

    async calendarFileRef(input: { id: string }): Promise<FileRef> {
      const event = events.find((item) => item.id === input.id);
      if (!event) throw new IpcError("E_NOT_FOUND", "Événement introuvable.");
      return clone(calendarEventRef(event));
    },

    async calendarSave(input: {
      event: LocalCalendarEvent;
      expected?: Sha256;
    }): Promise<LocalCalendarEvent> {
      const existingIndex = events.findIndex((item) => item.id === input.event.id);
      if (existingIndex >= 0) {
        const current = eventHashes.get(input.event.id);
        // Même contrat que Rust : une mise à jour sans précondition (ou avec
        // une version périmée) est refusée et n'écrase rien.
        if (input.expected === undefined || input.expected !== current) {
          throw new IpcError("E_PRECONDITION_FAILED", undefined, {
            details: current ? { currentHash: current } : {},
          });
        }
      } else if (input.expected !== undefined) {
        // La version attendue n'existe plus (suppression concurrente) : aucune
        // écriture, même contrat que Rust.
        throw new IpcError("E_PRECONDITION_FAILED", undefined, {
          details: { currentHash: null },
        });
      }

      const id = input.event.id || crypto.randomUUID();
      const existing = existingIndex >= 0 ? events[existingIndex] : undefined;
      const saved: LocalCalendarEvent = {
        ...input.event,
        id,
        // Invariant du contrat : l'UID est toujours le stem du fichier.
        uid: `${id}@dayali.local`,
        calendarId: "local",
        createdAt: existing ? existing.createdAt : input.event.createdAt || now().toISOString(),
        updatedAt: now().toISOString(),
        machineId: machineLocal.machineId,
        sequence: existing ? existing.sequence + 1 : Math.max(0, input.event.sequence),
      };
      const savedIndex = events.findIndex((item) => item.id === id);
      // Le vault stocke la version relue depuis le `.ics` ; la commande renvoie
      // l'objet de travail (avec `machineId` et millisecondes).
      const persisted = persistedCalendarEvent(saved);
      if (savedIndex >= 0) events[savedIndex] = persisted;
      else events = [...events, persisted];
      eventHashes.set(id, calendarEventHash(persisted));
      return clone(saved);
    },

    async calendarDelete(input: { eventId: string; expected: Sha256 }): Promise<void> {
      const event = events.find((item) => item.id === input.eventId);
      if (!event) throw new IpcError("E_NOT_FOUND", "Événement introuvable.");
      const current = eventHashes.get(input.eventId);
      if (input.expected === undefined || input.expected !== current) {
        throw new IpcError("E_PRECONDITION_FAILED", undefined, {
          details: current ? { currentHash: current } : {},
        });
      }
      events = events.filter((item) => item.id !== input.eventId);
      eventHashes.delete(input.eventId);
    },

    async calendarImportFeed(input: { feedId: string; url: string }): Promise<FeedStatus> {
      const status: FeedStatus = {
        feedId: input.feedId,
        url: input.url,
        lastFetchedAt: new Date().toISOString(),
        etag: null,
        lastModified: null,
        eventsCount: 0,
        error: null,
      };
      feeds = [...feeds.filter((feed) => feed.feedId !== input.feedId), status];
      return clone(status);
    },

    async reminderList(filter?: RemindersFilter): Promise<Reminder[]> {
      const today = formatLocalDate(now(), timeZone);
      const items = applyRemindersFilter(reminders, filter, today);
      return clone(items);
    },

    async reminderListDefs(): Promise<ReminderList[]> {
      return clone(lists);
    },

    async reminderReport(input: ReminderReportInput): Promise<Reminder> {
      if (typeof window !== "undefined" && (window as any).__FAIL_REMINDER_REPORT__) {
        throw new IpcError("E_CONFLICT", "Conflit disque simulé : écriture concurrente détectée.");
      }
      const reminder = reminders.find((item) => item.id === input.reminderId);
      if (!reminder) throw new IpcError("E_NOT_FOUND", "Rappel introuvable.");
      const key = `${input.reminderId}:${input.action}:${input.logicalDay}`;
      const previous = reminderHistory.get(key);
      if (previous?.status === "applied") return clone(reminder);
      const current = reminderHashes.get(reminder.id);
      if (current !== input.expected) throw new IpcError("E_PRECONDITION_FAILED");
      const at = new Date().toISOString();
      const historyEntry = {
        id: crypto.randomUUID(),
        status: "pending" as const,
        reminderId: input.reminderId,
        action: input.action,
        sourceDay: input.sourceDay,
        logicalDay: input.logicalDay,
        dueDate: reminder.dueDate,
        newDueDate: input.newDueDate ?? null,
        expectedHash: input.expected,
        createdAt: at,
        resolvedAt: null,
      };
      reminderHistory.set(key, { status: "pending", action: input.action });
      const vault = requireVault();
      vault.localState.reminderHistory = [...vault.localState.reminderHistory, historyEntry];
      const next: Reminder =
        input.action === "abandon"
          ? {
              ...reminder,
              status: "abandoned",
              abandonedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          : input.action === "restore"
            ? {
                ...reminder,
                status: "open",
                abandonedAt: null,
                updatedAt: new Date().toISOString(),
              }
            : {
                ...reminder,
                dueDate: input.newDueDate ?? reminder.dueDate,
                updatedAt: new Date().toISOString(),
              };
      const saved = await this.reminderSave({ reminder: next, expected: input.expected });
      reminderHistory.set(key, { status: "applied", action: input.action });
      vault.localState.reminderHistory = vault.localState.reminderHistory.map((entry) =>
        entry.id === historyEntry.id
          ? { ...entry, status: "applied" as const, resolvedAt: new Date().toISOString() }
          : entry,
      );
      return saved;
    },

    async reminderFileRef(input: { id: string }): Promise<FileRef> {
      const reminder = reminders.find((item) => item.id === input.id);
      if (!reminder) throw new IpcError("E_NOT_FOUND", "Rappel introuvable.");
      return clone(reminderRef(reminder, reminderHashes.get(reminder.id)));
    },

    async reminderSave(input: { reminder: Reminder; expected?: Sha256 }): Promise<Reminder> {
      const index = reminders.findIndex((item) => item.id === input.reminder.id);
      if (index >= 0) {
        const current = reminderHashes.get(input.reminder.id);
        if (input.expected === undefined || input.expected !== current) {
          throw new IpcError("E_PRECONDITION_FAILED", undefined, {
            details: current ? { currentHash: current } : {},
          });
        }
      } else if (input.expected !== undefined) {
        // La version attendue n'existe plus (suppression concurrente) : aucune
        // écriture, même contrat que Rust.
        throw new IpcError("E_PRECONDITION_FAILED");
      }
      const saved: Reminder = {
        ...input.reminder,
        // Comme Rust : un id vide à la création est remplacé par un identifiant
        // généré par le vault (UUIDv7 côté Rust).
        id: input.reminder.id || crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
        machineId: machineLocal.machineId,
      };
      const savedIndex = reminders.findIndex((item) => item.id === saved.id);
      if (savedIndex >= 0) reminders[savedIndex] = saved;
      else reminders = [...reminders, saved];
      reminderHashes.set(saved.id, reminderHash(saved));
      return clone(saved);
    },

    async reminderDelete(input: { id: string; expected: Sha256 }): Promise<void> {
      const reminder = reminders.find((item) => item.id === input.id);
      if (!reminder) throw new IpcError("E_NOT_FOUND", "Rappel introuvable.");
      const current = reminderHashes.get(input.id);
      if (input.expected === undefined || input.expected !== current) {
        throw new IpcError("E_PRECONDITION_FAILED", undefined, {
          details: current ? { currentHash: current } : {},
        });
      }
      reminders = reminders.filter((item) => item.id !== input.id);
      reminderHashes.delete(input.id);
    },

    async reminderListSave(input: {
      list: ReminderList;
      expected?: Sha256;
    }): Promise<ReminderList> {
      const index = lists.findIndex((item) => item.id === input.list.id);
      if (index >= 0) {
        // Même contrat que `list_save` : une mise à jour sans précondition est
        // refusée et n'écrase jamais la version sur disque.
        const current = listHashes.get(input.list.id);
        if (input.expected === undefined || input.expected !== current) {
          throw new IpcError("E_PRECONDITION_FAILED", undefined, {
            details: { currentHash: current ?? null },
          });
        }
      } else if (input.expected !== undefined) {
        // La version attendue n'existe plus (suppression concurrente) : aucune
        // écriture, même contrat que Rust.
        throw new IpcError("E_PRECONDITION_FAILED", undefined, {
          details: { currentHash: null },
        });
      }
      const saved: ReminderList = { ...input.list, updatedAt: now().toISOString() };
      if (index >= 0) lists[index] = saved;
      else lists = [...lists, saved];
      listHashes.set(saved.id, mockRevision(JSON.stringify(saved)));
      return clone(saved);
    },

    async reminderListDelete(input: { id: string; expected: Sha256 }): Promise<void> {
      const index = lists.findIndex((item) => item.id === input.id);
      if (index < 0) throw new IpcError("E_NOT_FOUND", "Liste introuvable.");
      const current = listHashes.get(input.id);
      if (input.expected === undefined || input.expected !== current) {
        throw new IpcError("E_PRECONDITION_FAILED", undefined, {
          details: { currentHash: current ?? null },
        });
      }
      lists = lists.filter((item) => item.id !== input.id);
      listHashes.delete(input.id);
    },
  };
}

/** Identifiant de machine du mock, exporté pour les tests. */
export const MOCK_MACHINE_ID = MACHINE_ID;
/** Détection du runtime : l'app tourne dans Tauri 2 ou dans un navigateur de dev. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Crée un mock IPC pré-peuplé avec des données riches et réalistes pour les captures d'écran et la démo. */
export function createRichMockIpc(): MockIpc {
  const vaultPath = "/Users/mock/Documents/Dayali";
  const now = new Date("2026-11-12T09:30:00.000Z");
  const reminders: Reminder[] = [
    {
      schemaVersion: 1,
      id: "rem-1",
      listId: "list-1",
      title: "Finaliser la spec technique de l'étape E4",
      notes: "Vérifier le contrat et les schémas Zod",
      status: "open",
      dueDate: "2026-11-12",
      dueTime: "11:00",
      dueTimeZone: "UTC",
      projectId: "proj-1",
      completedAt: null,
      abandonedAt: null,
      recurrence: null,
      sortKey: null,
      createdAt: "2026-11-10T08:00:00.000Z",
      updatedAt: "2026-11-10T08:00:00.000Z",
      machineId: MACHINE_ID,
    },
    {
      schemaVersion: 1,
      id: "rem-2",
      listId: "list-1",
      title: "Relire les notes d'architecture et schémas",
      notes: null,
      status: "open",
      dueDate: "2026-11-11",
      dueTime: null,
      dueTimeZone: null,
      projectId: null,
      completedAt: null,
      abandonedAt: null,
      recurrence: null,
      sortKey: null,
      createdAt: "2026-11-09T09:00:00.000Z",
      updatedAt: "2026-11-09T09:00:00.000Z",
      machineId: MACHINE_ID,
    },
    {
      schemaVersion: 1,
      id: "rem-3",
      listId: "list-1",
      title: "Vérifier le contrat IPC calendrier",
      notes: null,
      status: "done",
      dueDate: "2026-11-12",
      dueTime: "09:00",
      dueTimeZone: "UTC",
      projectId: null,
      completedAt: "2026-11-12T08:30:00.000Z",
      abandonedAt: null,
      recurrence: null,
      sortKey: null,
      createdAt: "2026-11-10T10:00:00.000Z",
      updatedAt: "2026-11-12T08:30:00.000Z",
      machineId: MACHINE_ID,
    },
    {
      schemaVersion: 1,
      id: "rem-4",
      listId: "list-2",
      title: "Ancien rappel obsolète",
      notes: null,
      status: "abandoned",
      dueDate: "2026-11-08",
      dueTime: null,
      dueTimeZone: null,
      projectId: null,
      completedAt: null,
      abandonedAt: "2026-11-08T10:00:00.000Z",
      recurrence: null,
      sortKey: null,
      createdAt: "2026-11-07T10:00:00.000Z",
      updatedAt: "2026-11-08T10:00:00.000Z",
      machineId: MACHINE_ID,
    },
  ];

  const lists: ReminderList[] = [
    {
      schemaVersion: 1,
      id: "list-1",
      name: "Travail",
      color: "blue",
      order: 1,
      archived: false,
      createdAt: "2026-10-20T07:05:00.000Z",
      updatedAt: "2026-10-20T07:05:00.000Z",
      machineId: MACHINE_ID,
    },
    {
      schemaVersion: 1,
      id: "list-2",
      name: "Personnel",
      color: "green",
      order: 2,
      archived: false,
      createdAt: "2026-10-20T07:05:00.000Z",
      updatedAt: "2026-10-20T07:05:00.000Z",
      machineId: MACHINE_ID,
    },
  ];

  const calendarEvents: LocalCalendarEvent[] = [
    {
      id: "ev-1",
      uid: "uid-1",
      calendarId: "cal-1",
      title: "Revue de sprint Q3",
      description: "Point d'équipe sur les avancées de l'itération.",
      location: "Salle 4B / Visio",
      start: { dateTime: "2026-11-12T09:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-12T10:30:00Z", timeZone: "UTC" },
      allDay: false,
      status: "confirmed",
      machineId: MACHINE_ID,
      createdAt: "2026-11-10T08:00:00.000Z",
      updatedAt: "2026-11-10T08:00:00.000Z",
      sequence: 0,
      projectId: null,
    },
    {
      id: "ev-2",
      uid: "uid-2",
      calendarId: "cal-1",
      title: "Point sync design & frontend",
      description: "Validation des composants d'interface et accessibilité.",
      location: "Visio",
      start: { dateTime: "2026-11-12T14:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-12T15:00:00Z", timeZone: "UTC" },
      allDay: false,
      status: "confirmed",
      machineId: MACHINE_ID,
      createdAt: "2026-11-10T08:00:00.000Z",
      updatedAt: "2026-11-10T08:00:00.000Z",
      sequence: 0,
      projectId: null,
    },
    {
      id: "ev-3",
      uid: "uid-3",
      calendarId: "cal-1",
      title: "Atelier architecture et vault",
      description: "Discussions sur la synchronisation et les schémas.",
      location: "Bureau principal",
      start: { dateTime: "2026-11-13T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-13T12:00:00Z", timeZone: "UTC" },
      allDay: false,
      status: "confirmed",
      machineId: MACHINE_ID,
      createdAt: "2026-11-10T08:00:00.000Z",
      updatedAt: "2026-11-10T08:00:00.000Z",
      sequence: 0,
      projectId: null,
    },
    {
      id: "ev-4",
      uid: "uid-4",
      calendarId: "cal-1",
      title: "Point d'équipe et revue de rentrée",
      description: "Coordination des priorités et suivi des étapes.",
      location: "Salle plénière",
      start: { dateTime: "2026-11-14T14:30:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-14T15:30:00Z", timeZone: "UTC" },
      allDay: false,
      status: "confirmed",
      machineId: MACHINE_ID,
      createdAt: "2026-11-10T08:00:00.000Z",
      updatedAt: "2026-11-10T08:00:00.000Z",
      sequence: 0,
      projectId: null,
    },
    {
      id: "ev-5",
      uid: "uid-5",
      calendarId: "cal-1",
      title: "Revue architecture & contrat IPC",
      description: "Validation des schémas de données et tests de non-régression.",
      location: "Bureau 2B",
      start: { dateTime: "2026-11-15T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-15T11:30:00Z", timeZone: "UTC" },
      allDay: false,
      status: "confirmed",
      machineId: MACHINE_ID,
      createdAt: "2026-11-10T08:00:00.000Z",
      updatedAt: "2026-11-10T08:00:00.000Z",
      sequence: 0,
      projectId: null,
    },
  ];

  return createMockIpc({
    now: () => now,
    initialVaultPath: vaultPath,
    moduleData: {
      reminders,
      lists,
      calendarEvents,
    },
  });
}
