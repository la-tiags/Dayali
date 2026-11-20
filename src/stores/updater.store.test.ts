import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AvailableUpdate,
  configureUpdater,
  resetUpdater,
  type UpdaterService,
} from "../lib/updater";
import { useUpdaterStore } from "./updater.store";

const UPDATE: AvailableUpdate = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "Rappels plus compacts.",
  date: "2026-11-20T10:00:00Z",
};

function fakeService(overrides: Partial<UpdaterService> = {}): UpdaterService {
  return {
    supported: true,
    currentVersion: async () => "0.1.0",
    check: async () => null,
    installAndRestart: async () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  resetUpdater();
  useUpdaterStore.setState({
    status: { phase: "idle" },
    currentVersion: null,
    supported: false,
    dismissedVersion: null,
  });
});

describe("updater.store", () => {
  it("lit la version installée et si les mises à jour sont prises en charge", async () => {
    configureUpdater(fakeService());
    await useUpdaterStore.getState().init();
    expect(useUpdaterStore.getState().currentVersion).toBe("0.1.0");
    expect(useUpdaterStore.getState().supported).toBe(true);
  });

  it("signale une version plus récente comme disponible", async () => {
    configureUpdater(fakeService({ check: async () => UPDATE }));
    await useUpdaterStore.getState().checkForUpdates();
    expect(useUpdaterStore.getState().status).toEqual({ phase: "available", update: UPDATE });
  });

  it("indique que l'app est à jour quand il n'y a rien de plus récent", async () => {
    configureUpdater(fakeService({ check: async () => null }));
    await useUpdaterStore.getState().checkForUpdates();
    expect(useUpdaterStore.getState().status.phase).toBe("upToDate");
  });

  it("une vérification de fond qui échoue (réseau coupé) ne dérange pas", async () => {
    configureUpdater(fakeService({ check: async () => Promise.reject(new Error("réseau")) }));
    await useUpdaterStore.getState().checkForUpdates({ silent: true });
    expect(useUpdaterStore.getState().status).toEqual({ phase: "idle" });
  });

  it("une vérification manuelle qui échoue affiche l'erreur", async () => {
    configureUpdater(fakeService({ check: async () => Promise.reject("404 Not Found") }));
    await useUpdaterStore.getState().checkForUpdates();
    const { status } = useUpdaterStore.getState();
    expect(status).toMatchObject({ phase: "error", update: null });
    expect(status.phase === "error" && status.message).toContain("404 Not Found");
  });

  it("ne fait rien quand les mises à jour ne sont pas prises en charge (navigateur)", async () => {
    const check = vi.fn(async () => UPDATE);
    configureUpdater(fakeService({ supported: false, check }));
    await useUpdaterStore.getState().checkForUpdates();
    expect(check).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().status).toEqual({ phase: "idle" });
  });

  it("ne lance pas deux vérifications en même temps", async () => {
    let release: (value: AvailableUpdate | null) => void = () => undefined;
    const check = vi.fn(
      () => new Promise<AvailableUpdate | null>((resolve) => (release = resolve)),
    );
    configureUpdater(fakeService({ check }));
    const first = useUpdaterStore.getState().checkForUpdates();
    await useUpdaterStore.getState().checkForUpdates();
    expect(check).toHaveBeenCalledTimes(1);
    release(null);
    await first;
  });

  it("suit la progression du téléchargement puis passe en redémarrage", async () => {
    const phases: string[] = [];
    useUpdaterStore.subscribe((state) => phases.push(state.status.phase));
    configureUpdater(
      fakeService({
        check: async () => UPDATE,
        installAndRestart: async ({ onProgress, onInstalled }) => {
          onProgress({ downloaded: 50, total: 200 });
          expect(useUpdaterStore.getState().status).toMatchObject({
            phase: "downloading",
            downloaded: 50,
            total: 200,
          });
          onInstalled();
        },
      }),
    );
    await useUpdaterStore.getState().checkForUpdates();
    await useUpdaterStore.getState().installUpdate();
    expect(useUpdaterStore.getState().status).toEqual({ phase: "restarting", update: UPDATE });
    expect(phases).toContain("downloading");
  });

  it("garde la mise à jour en mémoire si l'installation échoue, pour réessayer", async () => {
    const installAndRestart = vi
      .fn()
      .mockRejectedValueOnce(new Error("signature invalide"))
      .mockResolvedValueOnce(undefined);
    configureUpdater(fakeService({ check: async () => UPDATE, installAndRestart }));
    await useUpdaterStore.getState().checkForUpdates();

    await useUpdaterStore.getState().installUpdate();
    const failed = useUpdaterStore.getState().status;
    expect(failed).toMatchObject({ phase: "error", update: UPDATE });
    expect(failed.phase === "error" && failed.message).toContain("signature invalide");

    await useUpdaterStore.getState().installUpdate();
    expect(installAndRestart).toHaveBeenCalledTimes(2);
  });

  it("n'installe rien sans mise à jour connue", async () => {
    const installAndRestart = vi.fn();
    configureUpdater(fakeService({ installAndRestart }));
    await useUpdaterStore.getState().installUpdate();
    expect(installAndRestart).not.toHaveBeenCalled();
  });

  it("« Plus tard » mémorise la version masquée", async () => {
    configureUpdater(fakeService({ check: async () => UPDATE }));
    await useUpdaterStore.getState().checkForUpdates();
    useUpdaterStore.getState().dismissNotification();
    expect(useUpdaterStore.getState().dismissedVersion).toBe("0.2.0");
  });
});
