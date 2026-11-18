import { create } from "zustand";
import { isLocalCalendarEvent } from "../lib/agenda";
import type {
  CalendarItem,
  Config,
  ConfigSnapshot,
  DayState,
  EventTimePoint,
  LocalCalendarEvent,
  LocalDate,
  MachineLocal,
  ModuleStatus,
  Reminder,
  ReminderList,
  RemindersFilter,
  Sha256,
  VaultInfo,
} from "../lib/contracts/types";
import { getIpc } from "../lib/ipc";
import { type DayaliError, normalizeIpcError } from "../lib/ipc/errors";
import { localDateInZone } from "../lib/time";

/**
 * État applicatif de l'étape (a) : vault ouvert, configuration, état de journée.
 * Le vault reste la source de vérité ; ce store ne fait que refléter les
 * réponses IPC et n'écrit jamais de donnée métier en dehors des commandes
 * `vault_*` / `config_*` / `day_*`.
 *
 * Étape (c) : modules Agenda (agenda local + flux) et Rappels (listes, « Ma journée »).
 */

export type AppStatus = "idle" | "loading" | "ready";

export interface AppState {
  status: AppStatus;
  /** Une opération IPC est en cours (boutons désactivés, `aria-busy`). */
  busy: boolean;
  machineLocal: MachineLocal | null;
  vault: VaultInfo | null;
  config: Config | null;
  configRevision: Sha256 | null;
  /** Copie `.conflict-*` signalée par Rust : jamais masquée tant qu'elle existe. */
  configConflictCopy: string | null;
  dayState: DayState | null;
  error: DayaliError | null;
  /** Erreur de lancement (dernier vault inaccessible), affichée sur l'écran de choix. */
  bootError: DayaliError | null;

  /** Module Agenda (étape (c)). */
  agenda: AgendaState;
  agendaRange: { from: LocalDate; to: LocalDate } | null;

  /** Module Rappels (étape (c)). */
  reminders: RemindersState;
  remindersFilter: RemindersFilter | null;

  bootstrap: () => Promise<void>;
  openVault: (path: string) => Promise<boolean>;
  /** Crée `<parentPath>/<name>/` puis charge la session comme `openVault`. */
  createVault: (parentPath: string, name: string) => Promise<boolean>;
  closeVault: () => Promise<void>;
  startDay: (at?: Date) => Promise<boolean>;
  setOpenDashboardOnLaunch: (value: boolean) => Promise<boolean>;
  patchConfig: (
    patch: import("../lib/contracts/types").DeepPartial<import("../lib/contracts/types").Config>,
  ) => Promise<boolean>;
  markLateNightShown: (at?: Date) => Promise<boolean>;
  reloadConfig: () => Promise<void>;
  refreshMachineLocal: () => Promise<void>;
  dismissError: () => void;
  dismissBootError: () => void;

  loadAgenda: (range: { from: LocalDate; to: LocalDate }) => Promise<boolean>;
  reloadAgenda: () => Promise<boolean>;
  saveEvent: (input: { event: LocalCalendarEvent; expected?: Sha256 }) => Promise<boolean>;
  deleteEvent: (id: string) => Promise<boolean>;
  loadReminders: (filter?: RemindersFilter) => Promise<boolean>;
  reloadReminders: () => Promise<boolean>;
  saveReminder: (input: { reminder: Reminder; expected?: Sha256 }) => Promise<boolean>;
  deleteReminder: (id: string) => Promise<boolean>;
  saveReminderList: (list: ReminderList) => Promise<boolean>;
}

export interface AgendaState {
  readonly items: readonly CalendarItem[];
  /** Fichiers d'agenda ignorés à la lecture : jamais masqués, jamais réécrits. */
  readonly warnings: readonly string[];
  /**
   * Hash de la version réellement chargée, par id d'événement local. Seule
   * source de précondition pour modifier/supprimer (jamais de relecture juste
   * avant l'écriture).
   */
  readonly refs: Readonly<Record<string, Sha256>>;
  readonly status: ModuleStatus;
  readonly error: DayaliError | null;
}

export interface RemindersState {
  readonly items: readonly Reminder[];
  readonly lists: readonly ReminderList[];
  /**
   * Hash de la version que l'utilisateur a réellement chargée, par id de rappel.
   * C'est la seule source de précondition pour modifier/supprimer : jamais de
   * relecture juste avant l'écriture (PLAN §4.5).
   */
  readonly refs: Readonly<Record<string, Sha256>>;
  readonly status: ModuleStatus;
  readonly error: DayaliError | null;
}

/** Copie d'un index de hash sans une clé (jamais de hash périmé conservé). */
function withoutRef(refs: Readonly<Record<string, Sha256>>, id: string): Record<string, Sha256> {
  const next: Record<string, Sha256> = {};
  for (const [key, value] of Object.entries(refs)) {
    if (key !== id) next[key] = value;
  }
  return next;
}

function versionUnknownError(action: "modifier" | "supprimer"): DayaliError {
  return {
    code: "E_PRECONDITION_FAILED",
    message: `Version inconnue : recharge les rappels avant de ${action}.`,
    retryable: false,
  };
}

/** Le vault a changé pendant la lecture : on refuse d'appairer un contenu et un hash. */
function unstableSnapshotError(): DayaliError {
  return {
    code: "E_PRECONDITION_FAILED",
    message: "Les rappels ont changé pendant leur chargement. Recharge la liste.",
    retryable: true,
  };
}

function agendaVersionUnknownError(action: "modifier" | "supprimer"): DayaliError {
  return {
    code: "E_PRECONDITION_FAILED",
    message: `Version inconnue : recharge l'agenda avant de ${action}.`,
    retryable: false,
  };
}

function agendaUnstableSnapshotError(): DayaliError {
  return {
    code: "E_PRECONDITION_FAILED",
    message: "L'agenda a changé pendant son chargement. Recharge la liste.",
    retryable: true,
  };
}

function agendaConcurrentEditAfterSaveError(): DayaliError {
  return {
    code: "E_PRECONDITION_FAILED",
    message:
      "Événement enregistré, mais une autre version est apparue entre-temps. Recharge avant de le modifier.",
    retryable: false,
  };
}

function agendaUnreadableAfterSaveError(failure: DayaliError): DayaliError {
  return {
    ...failure,
    message:
      "Événement enregistré, mais sa version n'a pas pu être relue. Recharge avant de le modifier.",
  };
}

/** Nombre de tentatives pour relire une référence après une écriture réussie. */
const REF_REREAD_ATTEMPTS = 3;

/** L'écriture a réussi mais une autre version est apparue avant la relecture. */
function concurrentEditAfterSaveError(): DayaliError {
  return {
    code: "E_PRECONDITION_FAILED",
    message:
      "Rappel enregistré, mais une autre version est apparue entre-temps. Recharge avant de le modifier.",
    retryable: false,
  };
}

/** L'écriture a réussi mais la version écrite n'a pas pu être relue. */
function unreadableAfterSaveError(failure: DayaliError): DayaliError {
  return {
    ...failure,
    message:
      "Rappel enregistré, mais sa version n'a pas pu être relue. Recharge avant de le modifier.",
  };
}

/** Résultat explicite de la relecture post-écriture (jamais de sortie implicite). */
type SavedRefRead =
  | { readonly ok: true; readonly hash: Sha256 }
  | { readonly ok: false; readonly error: DayaliError };

/**
 * Relit la référence d'un rappel après une écriture réussie, puis relit la
 * liste entière : le hash n'est adopté que s'il décrit encore exactement
 * l'objet renvoyé par l'écriture. Si une autre machine a écrit entre-temps, le
 * hash relu serait celui de sa version : l'adopter ferait écraser cette
 * version à la prochaine édition. On préfère alors aucun hash (édition refusée
 * jusqu'à rechargement explicite).
 *
 * `JSON.stringify` suffit ici (les deux objets viennent du même contrat), mais
 * dépend de l'ordre des clés : un faux négatif ne peut que refuser un hash,
 * jamais en adopter un mauvais.
 */
async function readSavedRefWithRetry(saved: Reminder): Promise<SavedRefRead> {
  let lastError: DayaliError = {
    code: "E_INTERNAL",
    message: "La version enregistrée n'a pas pu être relue.",
    retryable: false,
  };
  for (let attempt = 0; attempt < REF_REREAD_ATTEMPTS; attempt += 1) {
    try {
      const ref = await getIpc().reminderFileRef({ id: saved.id });
      // Liste sans filtre : on veut l'état réel du vault pour cet id, pas une
      // vue partielle qui pourrait masquer une version concurrente.
      const latest = await getIpc().reminderList();
      const current = latest.find((item) => item.id === saved.id);
      if (current && JSON.stringify(current) === JSON.stringify(saved)) {
        return { ok: true, hash: ref.hash };
      }
      // Une version différente existe durablement : réessayer ne réappairerait
      // jamais le contenu affiché et le hash.
      return { ok: false, error: concurrentEditAfterSaveError() };
    } catch (error) {
      lastError = normalizeIpcError(error);
    }
  }
  return { ok: false, error: unreadableAfterSaveError(lastError) };
}

/** Remplace le rappel dans la liste, ou l'ajoute en tête s'il est absent. */
function withSavedReminder(items: readonly Reminder[], saved: Reminder): Reminder[] {
  return items.some((item) => item.id === saved.id)
    ? items.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...items];
}

/** Remplace l'événement dans la liste, ou l'ajoute s'il est absent. */
function withSavedEvent(items: readonly CalendarItem[], saved: LocalCalendarEvent): CalendarItem[] {
  return items.some((item) => isLocalCalendarEvent(item) && item.id === saved.id)
    ? items.map((item) => (isLocalCalendarEvent(item) && item.id === saved.id ? saved : item))
    : [saved, ...items];
}

/** Ramène un horodatage à la seconde, précision réellement persistée en `.ics`. */
function truncateIsoToSecond(value: string): string {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return value;
  return new Date(Math.floor(instant / 1000) * 1000).toISOString();
}

function timePointForComparison(point: EventTimePoint) {
  return "date" in point
    ? { date: point.date }
    : { dateTime: truncateIsoToSecond(point.dateTime), timeZone: point.timeZone };
}

/**
 * Compare l'objet renvoyé par `calendar_save` et sa relecture depuis le `.ics`.
 * Le fichier ne persiste ni `machineId` ni les fractions de seconde : ce sont
 * des écarts attendus, pas une écriture concurrente. Tous les autres champs
 * doivent correspondre, sinon le hash relu n'est pas adopté.
 */
function samePersistedEvent(current: LocalCalendarEvent, saved: LocalCalendarEvent): boolean {
  const project = (event: LocalCalendarEvent) => ({
    id: event.id,
    uid: event.uid,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    allDay: event.allDay,
    start: timePointForComparison(event.start),
    end: timePointForComparison(event.end),
    projectId: event.projectId,
    createdAt: truncateIsoToSecond(event.createdAt),
    updatedAt: truncateIsoToSecond(event.updatedAt),
    sequence: event.sequence,
    status: event.status,
  });
  return JSON.stringify(project(current)) === JSON.stringify(project(saved));
}

/** Fenêtre minimale couvrant un événement, utilisée si l'agenda n'a pas de plage chargée. */
function rangeForEvent(event: LocalCalendarEvent): { from: LocalDate; to: LocalDate } | null {
  const startDate =
    "date" in event.start
      ? event.start.date
      : localDateInZone(event.start.dateTime, event.start.timeZone);
  const endDate =
    "date" in event.end ? event.end.date : localDateInZone(event.end.dateTime, event.end.timeZone);
  if (!startDate || !endDate) return null;
  return startDate <= endDate ? { from: startDate, to: endDate } : { from: endDate, to: startDate };
}

/**
 * Relit le hash d'un événement après une écriture réussie, puis relit la liste
 * de la fenêtre : le hash n'est adopté que s'il décrit encore exactement
 * l'objet renvoyé par l'écriture. Sinon aucun hash n'est conservé et une erreur
 * visible invite à recharger (jamais d'écrasement silencieux).
 */
async function readSavedEventRefWithRetry(
  saved: LocalCalendarEvent,
  range: { from: LocalDate; to: LocalDate },
): Promise<SavedRefRead> {
  let lastError: DayaliError = {
    code: "E_INTERNAL",
    message: "La version enregistrée n'a pas pu être relue.",
    retryable: false,
  };
  for (let attempt = 0; attempt < REF_REREAD_ATTEMPTS; attempt += 1) {
    try {
      const ref = await getIpc().calendarFileRef({ id: saved.id });
      const latest = await getIpc().calendarList({ from: range.from, to: range.to });
      const current = latest.items.find(
        (item): item is LocalCalendarEvent => isLocalCalendarEvent(item) && item.id === saved.id,
      );
      if (current && samePersistedEvent(current, saved)) {
        return { ok: true, hash: ref.hash };
      }
      return { ok: false, error: agendaConcurrentEditAfterSaveError() };
    } catch (error) {
      lastError = normalizeIpcError(error);
    }
  }
  return { ok: false, error: agendaUnreadableAfterSaveError(lastError) };
}

interface InitialData {
  status: AppStatus;
  busy: boolean;
  machineLocal: MachineLocal | null;
  vault: VaultInfo | null;
  config: Config | null;
  configRevision: Sha256 | null;
  configConflictCopy: string | null;
  dayState: DayState | null;
  error: DayaliError | null;
  bootError: DayaliError | null;
  agenda: AgendaState;
  agendaRange: { from: LocalDate; to: LocalDate } | null;
  reminders: RemindersState;
  remindersFilter: RemindersFilter | null;
}

function emptyAgendaState(): AgendaState {
  return { items: [], warnings: [], refs: {}, status: "idle", error: null };
}

function createInitialData(): InitialData {
  return {
    status: "idle",
    busy: false,
    machineLocal: null,
    vault: null,
    config: null,
    configRevision: null,
    configConflictCopy: null,
    dayState: null,
    error: null,
    bootError: null,
    agenda: emptyAgendaState(),
    agendaRange: null,
    reminders: { items: [], lists: [], refs: {}, status: "idle", error: null },
    remindersFilter: null,
  };
}

type SnapshotFields = Pick<AppState, "config" | "configRevision" | "configConflictCopy">;

function snapshotFields(snapshot: ConfigSnapshot): SnapshotFields {
  return {
    config: snapshot.config,
    configRevision: snapshot.revision,
    configConflictCopy: snapshot.conflictCopy,
  };
}

/**
 * Charge la session d'un vault déjà ouvert ou fraîchement créé.
 * Une erreur conserve le vault éventuellement déjà ouvert et reste affichée.
 */
async function loadOpenedVault(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  load: () => Promise<VaultInfo>,
): Promise<boolean> {
  if (get().busy) return false;
  const api = getIpc();
  set({ busy: true, error: null });
  try {
    const vault = await load();
    const [snapshot, dayState, machineLocal] = await Promise.all([
      api.configGet(),
      api.dayStateGet(),
      api.machineLocalGet(),
    ]);
    set({
      vault,
      dayState,
      machineLocal,
      ...snapshotFields(snapshot),
      status: "ready",
      busy: false,
      error: null,
      agenda: emptyAgendaState(),
      agendaRange: null,
      reminders: { items: [], lists: [], refs: {}, status: "idle", error: null },
      remindersFilter: null,
    });
    return true;
  } catch (error) {
    // On conserve le vault éventuellement déjà ouvert : une ouverture ratée ne
    // doit pas fermer la session en cours (et le message reste visible).
    set({ busy: false, error: normalizeIpcError(error) });
    return false;
  }
}

export const useAppStore = create<AppState>()((set, get) => ({
  ...createInitialData(),

  async bootstrap() {
    if (get().status !== "idle") return;
    set({ status: "loading", error: null, bootError: null });
    const api = getIpc();
    let machineLocal: MachineLocal;
    try {
      machineLocal = await api.machineLocalGet();
    } catch (error) {
      set({ status: "ready", bootError: normalizeIpcError(error) });
      return;
    }
    set({ machineLocal });

    if (!machineLocal.lastVaultPath) {
      set({ status: "ready" });
      return;
    }

    const opened = await get().openVault(machineLocal.lastVaultPath);
    if (!opened) {
      // Sans ce passage à `ready`, le splash resterait affiché indéfiniment et
      // l'écran de choix ne montrerait jamais l'erreur de lancement.
      const failure = get().error;
      set(failure ? { status: "ready", bootError: failure, error: null } : { status: "ready" });
    }
  },

  openVault(path) {
    return loadOpenedVault(set, get, () => getIpc().vaultOpen({ path }));
  },

  createVault(parentPath, name) {
    return loadOpenedVault(set, get, () => getIpc().vaultCreate({ parentPath, name }));
  },

  async closeVault() {
    const api = getIpc();
    try {
      if (get().vault) await api.vaultClose();
    } catch {
      // `vault_close` ne doit pas bloquer le retour à l'écran de choix.
    }
    set({
      vault: null,
      config: null,
      configRevision: null,
      configConflictCopy: null,
      dayState: null,
      error: null,
      status: "ready",
      agenda: emptyAgendaState(),
      agendaRange: null,
      reminders: { items: [], lists: [], refs: {}, status: "idle", error: null },
      remindersFilter: null,
    });
  },

  async startDay(at = new Date()) {
    if (get().busy) return false;
    if (!get().vault) return false;
    set({ busy: true, error: null });
    try {
      const dayState = await getIpc().dayStart({ at: at.toISOString() });
      set({ dayState, busy: false });
      return true;
    } catch (error) {
      set({ busy: false, error: normalizeIpcError(error) });
      return false;
    }
  },

  async setOpenDashboardOnLaunch(value) {
    const { config, configRevision } = get();
    if (!config || !configRevision) return false;
    if (config.openDashboardOnLaunch === value) return true;
    set({ busy: true, error: null });
    try {
      const snapshot = await getIpc().configPatch({
        patch: { openDashboardOnLaunch: value },
        expectedRevision: configRevision,
      });
      set({ ...snapshotFields(snapshot), busy: false });
      return true;
    } catch (error) {
      // `E_PRECONDITION_FAILED` : aucune écriture, aucune reprise automatique.
      // L'utilisateur voit l'erreur et peut recharger explicitement la config.
      set({ busy: false, error: normalizeIpcError(error) });
      return false;
    }
  },

  async patchConfig(patch) {
    const { configRevision } = get();
    if (!configRevision) return false;
    set({ busy: true, error: null });
    try {
      const snapshot = await getIpc().configPatch({
        patch,
        expectedRevision: configRevision,
      });
      set({ ...snapshotFields(snapshot), busy: false });
      return true;
    } catch (error) {
      set({ busy: false, error: normalizeIpcError(error) });
      return false;
    }
  },

  async markLateNightShown(at = new Date()) {
    if (get().busy) return false;
    if (!get().vault) return false;
    set({ busy: true, error: null });
    try {
      const dayState = await getIpc().dayMarkLateNightShown({ at: at.toISOString() });
      set({ dayState, busy: false });
      return true;
    } catch (error) {
      set({ busy: false, error: normalizeIpcError(error) });
      return false;
    }
  },

  async reloadConfig() {
    if (!get().vault) return;
    set({ busy: true, error: null });
    try {
      const snapshot = await getIpc().configGet();
      set({ ...snapshotFields(snapshot), busy: false });
    } catch (error) {
      set({ busy: false, error: normalizeIpcError(error) });
    }
  },

  async refreshMachineLocal() {
    try {
      const machineLocal = await getIpc().machineLocalGet();
      set({ machineLocal });
    } catch (error) {
      set({ error: normalizeIpcError(error) });
    }
  },

  dismissError() {
    set({ error: null });
  },

  dismissBootError() {
    set({ bootError: null });
  },

  async loadAgenda(range) {
    if (!get().vault) return false;
    set({
      agenda: { items: [], warnings: [], refs: {}, status: "loading", error: null },
      agendaRange: range,
    });
    try {
      // Deux lectures consécutives : les hashes doivent décrire **exactement**
      // le contenu publié. Si la fenêtre change entre-temps, on recommence au
      // lieu d'appairer un contenu ancien avec un hash récent.
      for (let attempt = 0; attempt < REF_REREAD_ATTEMPTS; attempt += 1) {
        const first = await getIpc().calendarList({ from: range.from, to: range.to });
        const localItems = first.items.filter(isLocalCalendarEvent);
        const refs: Record<string, Sha256> = {};
        const results = await Promise.allSettled(
          localItems.map((item) => getIpc().calendarFileRef({ id: item.id })),
        );
        results.forEach((result, index) => {
          const item = localItems[index];
          if (item && result.status === "fulfilled") refs[item.id] = result.value.hash;
        });
        const again = await getIpc().calendarList({ from: range.from, to: range.to });
        if (
          JSON.stringify(again.items) === JSON.stringify(first.items) &&
          JSON.stringify(again.warnings) === JSON.stringify(first.warnings)
        ) {
          set({
            agenda: {
              items: first.items,
              warnings: first.warnings,
              refs,
              status: "ready",
              error: null,
            },
          });
          return true;
        }
      }
      throw agendaUnstableSnapshotError();
    } catch (error) {
      set({
        agenda: {
          items: [],
          warnings: [],
          refs: {},
          status: "error",
          error: normalizeIpcError(error),
        },
      });
      return false;
    }
  },

  async reloadAgenda(): Promise<boolean> {
    const range = get().agendaRange;
    if (!range) return false;
    return get().loadAgenda(range);
  },

  async saveEvent(input) {
    if (!get().vault) return false;
    const id = input.event.id;
    const current = get().agenda;
    const expected = input.expected ?? (id ? current.refs[id] : undefined);
    if (id && !expected) {
      // Jamais de relecture « réparatrice » juste avant l'écriture : elle
      // écraserait silencieusement une version modifiée par une autre machine.
      set({
        agenda: { ...current, status: "error", error: agendaVersionUnknownError("modifier") },
      });
      return false;
    }
    try {
      const saved = await getIpc().calendarSave(
        expected ? { event: input.event, expected } : { event: input.event },
      );
      // Le serveur réécrit uid/updatedAt/machineId/sequence : on affiche la
      // valeur renvoyée, jamais l'objet envoyé.
      const afterSave = get().agenda;
      set({
        agenda: {
          ...afterSave,
          items: withSavedEvent(afterSave.items, saved),
          status: "ready",
          error: null,
        },
      });
      // La relecture doit couvrir l'événement lui-même : la fenêtre affichée
      // peut ne pas le contenir (création bien après les 30 jours affichés), et
      // ce n'est pas un conflit.
      const range = rangeForEvent(saved) ?? get().agendaRange;
      const reread = range
        ? await readSavedEventRefWithRetry(saved, range)
        : {
            ok: false as const,
            error: agendaUnreadableAfterSaveError({
              code: "E_INTERNAL",
              message: "Fenêtre d'agenda inconnue.",
              retryable: false,
            }),
          };
      const latest = get().agenda;
      if (reread.ok) {
        set({
          agenda: {
            ...latest,
            items: withSavedEvent(latest.items, saved),
            refs: { ...withoutRef(latest.refs, saved.id), [saved.id]: reread.hash },
            status: "ready",
            error: null,
          },
        });
      } else {
        set({
          agenda: {
            ...latest,
            items: withSavedEvent(latest.items, saved),
            refs: withoutRef(latest.refs, saved.id),
            status: "ready",
            error: reread.error,
          },
        });
      }
      return true;
    } catch (error) {
      const latest = get().agenda;
      set({
        agenda: { ...latest, status: "error", error: normalizeIpcError(error) },
      });
      return false;
    }
  },

  async deleteEvent(id: string): Promise<boolean> {
    if (!get().vault) return false;
    const current = get().agenda;
    const expected = current.refs[id];
    if (!expected) {
      set({
        agenda: { ...current, status: "error", error: agendaVersionUnknownError("supprimer") },
      });
      return false;
    }
    try {
      // Précondition = hash de la version chargée, jamais un hash relu ici.
      await getIpc().calendarDelete({ eventId: id, expected });
      const latest = get().agenda;
      set({
        agenda: {
          ...latest,
          items: latest.items.filter((item) => !(isLocalCalendarEvent(item) && item.id === id)),
          refs: withoutRef(latest.refs, id),
          status: "ready",
          error: null,
        },
      });
      return true;
    } catch (error) {
      const failure = normalizeIpcError(error);
      if (failure.code === "E_NOT_FOUND") {
        // L'événement a disparu (sync, autre machine) : on recharge la fenêtre
        // réelle au lieu de garder une ligne fantôme, sans prétendre au succès.
        const range = get().agendaRange;
        if (range) await get().loadAgenda(range);
        set({ agenda: { ...get().agenda, status: "error", error: failure } });
        return false;
      }
      const latest = get().agenda;
      set({
        agenda: { ...latest, status: "error", error: failure },
      });
      return false;
    }
  },

  async loadReminders(filter) {
    if (!get().vault) return false;
    set({
      remindersFilter: filter ?? null,
      reminders: { items: [], lists: [], refs: {}, status: "loading", error: null },
    });
    try {
      // Les hashes servent de précondition : ils doivent décrire **exactement**
      // le contenu affiché. On relit donc la liste après avoir lu les hashes.
      // Si elle a changé entre-temps, on recommence au lieu d'appairer un
      // contenu ancien avec un hash récent (ce qui écraserait en silence une
      // écriture concurrente). Un échec isolé de hash ne retire pas le rappel :
      // son édition sera refusée explicitement.
      for (let attempt = 0; attempt < REF_REREAD_ATTEMPTS; attempt += 1) {
        const [items, lists] = await Promise.all([
          getIpc().reminderList(filter),
          getIpc().reminderListDefs(),
        ]);
        const refs: Record<string, Sha256> = {};
        const results = await Promise.allSettled(
          items.map((item) => getIpc().reminderFileRef({ id: item.id })),
        );
        results.forEach((result, index) => {
          const item = items[index];
          if (item && result.status === "fulfilled") refs[item.id] = result.value.hash;
        });
        const [again, listsAgain] = await Promise.all([
          getIpc().reminderList(filter),
          getIpc().reminderListDefs(),
        ]);
        // Contenu **et** définitions doivent être stables : publier des
        // définitions périmées ferait afficher des listes qui n'existent plus.
        if (
          JSON.stringify(again) === JSON.stringify(items) &&
          JSON.stringify(listsAgain) === JSON.stringify(lists)
        ) {
          set({ reminders: { items, lists, refs, status: "ready", error: null } });
          return true;
        }
      }
      throw unstableSnapshotError();
    } catch (error) {
      set({
        reminders: {
          items: [],
          lists: [],
          refs: {},
          status: "error",
          error: normalizeIpcError(error),
        },
      });
      return false;
    }
  },

  async reloadReminders(): Promise<boolean> {
    const filter = get().remindersFilter;
    return get().loadReminders(filter ?? undefined);
  },

  async saveReminder(input: { reminder: Reminder; expected?: Sha256 }): Promise<boolean> {
    if (!get().vault) return false;
    const id = input.reminder.id;
    const current = get().reminders;
    const expected = input.expected ?? (id ? current.refs[id] : undefined);
    if (id && !expected) {
      // Jamais de relecture « réparatrice » du hash juste avant l'écriture :
      // cela écraserait silencieusement une version modifiée par une autre
      // machine. L'utilisateur doit recharger explicitement.
      set({
        reminders: { ...current, status: "error", error: versionUnknownError("modifier") },
      });
      return false;
    }
    try {
      const saved = await getIpc().reminderSave(
        expected ? { reminder: input.reminder, expected } : { reminder: input.reminder },
      );
      // Le serveur réécrit `updatedAt`/`machineId` : la liste affiche la valeur
      // renvoyée, jamais l'objet envoyé (sinon l'UI mentirait sur l'état du vault).
      const afterSave = get().reminders;
      set({
        reminders: {
          ...afterSave,
          items: withSavedReminder(afterSave.items, saved),
          status: "ready",
          error: null,
        },
      });
      // Après une écriture réussie, relire la référence est légitime, mais
      // seulement si le vault contient encore exactement la version écrite.
      // Si une autre machine a écrit entre-temps, le hash relu est le sien et
      // l'adopter écraserait sa version à la prochaine édition : on retire tout
      // hash et on garde une erreur visible. L'écriture reste un succès (ne pas
      // inciter à recréer le rappel et à le dupliquer).
      const reread = await readSavedRefWithRetry(saved);
      const latest = get().reminders;
      if (reread.ok) {
        set({
          reminders: {
            ...latest,
            items: withSavedReminder(latest.items, saved),
            refs: { ...withoutRef(latest.refs, saved.id), [saved.id]: reread.hash },
            status: "ready",
            error: null,
          },
        });
      } else {
        set({
          reminders: {
            ...latest,
            items: withSavedReminder(latest.items, saved),
            refs: withoutRef(latest.refs, saved.id),
            status: "ready",
            error: reread.error,
          },
        });
      }
      return true;
    } catch (error) {
      const latest = get().reminders;
      set({
        reminders: {
          ...latest,
          status: "error",
          error: normalizeIpcError(error),
        },
      });
      return false;
    }
  },

  async deleteReminder(id: string): Promise<boolean> {
    if (!get().vault) return false;
    const current = get().reminders;
    const expected = current.refs[id];
    if (!expected) {
      set({
        reminders: { ...current, status: "error", error: versionUnknownError("supprimer") },
      });
      return false;
    }
    try {
      // Précondition = hash de la version chargée, jamais un hash relu ici.
      await getIpc().reminderDelete({ id, expected });
      const latest = get().reminders;
      set({
        reminders: {
          ...latest,
          items: latest.items.filter((item) => item.id !== id),
          refs: withoutRef(latest.refs, id),
          status: "ready",
          error: null,
        },
      });
      return true;
    } catch (error) {
      const failure = normalizeIpcError(error);
      const latest = get().reminders;
      if (failure.code === "E_NOT_FOUND") {
        // Le rappel a disparu (sync, autre machine) : on affiche l'état réel du
        // vault au lieu de laisser une ligne fantôme, sans prétendre au succès.
        await get().loadReminders(get().remindersFilter ?? undefined);
        set({
          reminders: { ...get().reminders, status: "error", error: failure },
        });
        return false;
      }
      // Aucune suppression locale en cas d'échec : le rappel reste affiché.
      set({
        reminders: {
          ...latest,
          status: "error",
          error: failure,
        },
      });
      return false;
    }
  },

  async saveReminderList(list: ReminderList): Promise<boolean> {
    if (!get().vault) return false;
    try {
      const saved = await getIpc().reminderListSave({ list });
      const current = get().reminders;
      const lists = current.lists.some((l) => l.id === saved.id)
        ? current.lists.map((l) => (l.id === saved.id ? saved : l))
        : [...current.lists, saved];
      set({
        reminders: {
          ...current,
          lists,
          status: "ready",
          error: null,
        },
      });
      return true;
    } catch (error) {
      set({
        reminders: {
          ...get().reminders,
          status: "error",
          error: normalizeIpcError(error),
        },
      });
      return false;
    }
  },
}));

/** Réinitialisation entre deux tests (les actions du store sont conservées). */
export function resetAppStore(): void {
  useAppStore.setState(createInitialData());
}
