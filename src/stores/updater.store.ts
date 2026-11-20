import { create } from "zustand";
import { type AvailableUpdate, getUpdater } from "../lib/updater";

export type UpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate"; checkedAt: string }
  | { phase: "available"; update: AvailableUpdate }
  | { phase: "downloading"; update: AvailableUpdate; downloaded: number; total: number | null }
  | { phase: "restarting"; update: AvailableUpdate }
  | { phase: "error"; message: string; update: AvailableUpdate | null };

interface UpdaterState {
  status: UpdateStatus;
  currentVersion: string | null;
  supported: boolean;
  /** Version dont la notification a été fermée (« Plus tard ») : on ne la réaffiche pas. */
  dismissedVersion: string | null;
  init: () => Promise<void>;
  /** `silent` : vérification de fond au démarrage, une erreur réseau ne dérange personne. */
  checkForUpdates: (options?: { silent?: boolean }) => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissNotification: () => void;
}

const BUSY: ReadonlySet<UpdateStatus["phase"]> = new Set(["checking", "downloading", "restarting"]);

function describeError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return "Erreur inconnue.";
}

/**
 * Mises à jour de l'application depuis les releases GitHub. Le store ne fait que refléter
 * l'état du service `UpdaterService` ; rien n'est installé sans action explicite de la personne.
 */
export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: { phase: "idle" },
  currentVersion: null,
  supported: false,
  dismissedVersion: null,

  async init() {
    const service = getUpdater();
    set({ supported: service.supported });
    try {
      set({ currentVersion: await service.currentVersion() });
    } catch {
      set({ currentVersion: null });
    }
  },

  async checkForUpdates(options = {}) {
    if (BUSY.has(get().status.phase)) return;
    const service = getUpdater();
    if (!service.supported) return;
    set({ status: { phase: "checking" } });
    try {
      const update = await service.check();
      set({
        status: update
          ? { phase: "available", update }
          : { phase: "upToDate", checkedAt: new Date().toISOString() },
      });
    } catch (error) {
      set({
        status: options.silent
          ? { phase: "idle" }
          : {
              phase: "error",
              message: `Impossible de vérifier les mises à jour : ${describeError(error)}`,
              update: null,
            },
      });
    }
  },

  async installUpdate() {
    const { status } = get();
    const update = status.phase === "available" || status.phase === "error" ? status.update : null;
    if (!update) return;
    const service = getUpdater();
    set({ status: { phase: "downloading", update, downloaded: 0, total: null } });
    try {
      await service.installAndRestart({
        onProgress: ({ downloaded, total }) =>
          set({ status: { phase: "downloading", update, downloaded, total } }),
        onInstalled: () => set({ status: { phase: "restarting", update } }),
      });
    } catch (error) {
      set({
        status: {
          phase: "error",
          message: `L'installation a échoué : ${describeError(error)}`,
          update,
        },
      });
    }
  },

  dismissNotification() {
    const { status } = get();
    const update = status.phase === "available" || status.phase === "error" ? status.update : null;
    if (update) set({ dismissedVersion: update.version });
  },
}));
