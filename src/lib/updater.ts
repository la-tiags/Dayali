import { isTauriRuntime } from "./ipc/runtime";

/** Mise à jour proposée par la dernière release GitHub (lue depuis `latest.json`). */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  /** Notes de version de la release, si elles existent. */
  notes: string | null;
  /** Date de publication (ISO), si connue. */
  date: string | null;
}

export interface DownloadProgress {
  downloaded: number;
  /** Taille totale en octets ; `null` tant qu'elle est inconnue. */
  total: number | null;
}

export interface InstallHandlers {
  onProgress: (progress: DownloadProgress) => void;
  /** Appelé quand l'installation est terminée, juste avant le redémarrage. */
  onInstalled: () => void;
}

export interface UpdaterService {
  /** `false` hors de l'application Tauri (navigateur de dev, tests). */
  readonly supported: boolean;
  currentVersion(): Promise<string>;
  /** Interroge GitHub Releases ; `null` si la version installée est déjà la dernière. */
  check(): Promise<AvailableUpdate | null>;
  /** Télécharge, vérifie la signature, installe puis redémarre l'application. */
  installAndRestart(handlers: InstallHandlers): Promise<void>;
}

export interface TauriUpdaterOptions {
  /**
   * Autorise l'installation. Désactivée par défaut en mode développement : le binaire de `tauri dev`
   * n'est pas un `.app` installé, et le remplacer n'a pas de sens.
   */
  allowInstall?: boolean;
}

/** Service utilisé hors Tauri : aucune vérification possible, version de développement. */
export function createUnsupportedUpdater(): UpdaterService {
  return {
    supported: false,
    currentVersion: async () => "développement",
    check: async () => null,
    installAndRestart: async () => {
      throw new Error("Les mises à jour ne sont disponibles que dans l'application installée.");
    },
  };
}

/** Service réel : plugins Tauri `updater` et `process`, chargés à la demande. */
export function createTauriUpdater(options: TauriUpdaterOptions = {}): UpdaterService {
  const allowInstall = options.allowInstall ?? !import.meta.env.DEV;
  type PluginUpdate = NonNullable<
    Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater")["check"]>>
  >;
  let pending: PluginUpdate | null = null;

  return {
    supported: true,
    async currentVersion() {
      const { getVersion } = await import("@tauri-apps/api/app");
      return getVersion();
    },
    async check() {
      const { check } = await import("@tauri-apps/plugin-updater");
      pending = await check();
      if (!pending) return null;
      return {
        version: pending.version,
        currentVersion: pending.currentVersion,
        notes: pending.body?.trim() ? pending.body.trim() : null,
        date: pending.date ?? null,
      };
    },
    async installAndRestart({ onProgress, onInstalled }) {
      if (!allowInstall) {
        throw new Error("L'installation est désactivée en mode développement.");
      }
      if (!pending) {
        throw new Error("Aucune mise à jour à installer : relancez la vérification.");
      }
      let downloaded = 0;
      let total: number | null = null;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          onProgress({ downloaded, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          onProgress({ downloaded, total });
        }
      });
      onInstalled();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

let current: UpdaterService | null = null;

/** Service actif : réel dans Tauri, « non pris en charge » ailleurs (ou celui injecté par les tests). */
export function getUpdater(): UpdaterService {
  if (!current) {
    current = isTauriRuntime() ? createTauriUpdater() : createUnsupportedUpdater();
  }
  return current;
}

export function configureUpdater(service: UpdaterService): void {
  current = service;
}

export function resetUpdater(): void {
  current = null;
}
