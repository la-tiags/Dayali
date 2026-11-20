import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginCheck = vi.fn();
const relaunch = vi.fn(async () => undefined);

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => pluginCheck() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));

import { createTauriUpdater, createUnsupportedUpdater } from "./updater";

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

function pluginUpdate(overrides: Record<string, unknown> = {}) {
  const downloadAndInstall = vi.fn(async (onEvent: (event: DownloadEvent) => void) => {
    onEvent({ event: "Started", data: { contentLength: 1000 } });
    onEvent({ event: "Progress", data: { chunkLength: 400 } });
    onEvent({ event: "Progress", data: { chunkLength: 600 } });
    onEvent({ event: "Finished" });
  });
  return {
    version: "0.2.0",
    currentVersion: "0.1.0",
    body: "  Nouveautés  ",
    date: "2026-11-20T10:00:00Z",
    downloadAndInstall,
    ...overrides,
  };
}

beforeEach(() => {
  pluginCheck.mockReset();
  relaunch.mockClear();
});

describe("service d'updater Tauri", () => {
  it("renvoie null quand aucune release plus récente n'existe", async () => {
    pluginCheck.mockResolvedValue(null);
    expect(await createTauriUpdater({ allowInstall: true }).check()).toBeNull();
  });

  it("décrit la mise à jour disponible (notes nettoyées)", async () => {
    pluginCheck.mockResolvedValue(pluginUpdate());
    expect(await createTauriUpdater({ allowInstall: true }).check()).toEqual({
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "Nouveautés",
      date: "2026-11-20T10:00:00Z",
    });
  });

  it("notes vides ou absentes : null", async () => {
    pluginCheck.mockResolvedValue(pluginUpdate({ body: "   ", date: undefined }));
    const update = await createTauriUpdater({ allowInstall: true }).check();
    expect(update?.notes).toBeNull();
    expect(update?.date).toBeNull();
  });

  it("télécharge avec progression, installe puis redémarre", async () => {
    pluginCheck.mockResolvedValue(pluginUpdate());
    const service = createTauriUpdater({ allowInstall: true });
    await service.check();
    const progress: Array<{ downloaded: number; total: number | null }> = [];
    const onInstalled = vi.fn();
    await service.installAndRestart({ onProgress: (p) => progress.push(p), onInstalled });
    expect(progress).toEqual([
      { downloaded: 0, total: 1000 },
      { downloaded: 400, total: 1000 },
      { downloaded: 1000, total: 1000 },
    ]);
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("refuse d'installer sans avoir vérifié d'abord", async () => {
    await expect(
      createTauriUpdater({ allowInstall: true }).installAndRestart({
        onProgress: vi.fn(),
        onInstalled: vi.fn(),
      }),
    ).rejects.toThrow(/relancez la vérification/);
  });

  it("n'installe jamais en mode développement", async () => {
    pluginCheck.mockResolvedValue(pluginUpdate());
    const update = pluginUpdate();
    pluginCheck.mockResolvedValue(update);
    const service = createTauriUpdater({ allowInstall: false });
    await service.check();
    await expect(
      service.installAndRestart({ onProgress: vi.fn(), onInstalled: vi.fn() }),
    ).rejects.toThrow(/mode développement/);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("expose la version de l'application", async () => {
    expect(await createTauriUpdater().currentVersion()).toBe("0.1.0");
  });
});

describe("service d'updater hors Tauri", () => {
  it("n'est pas pris en charge et ne vérifie rien", async () => {
    const service = createUnsupportedUpdater();
    expect(service.supported).toBe(false);
    expect(await service.check()).toBeNull();
    await expect(
      service.installAndRestart({ onProgress: vi.fn(), onInstalled: vi.fn() }),
    ).rejects.toThrow();
  });
});
