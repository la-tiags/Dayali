import type { IpcApi } from "./api";
import { createMockIpc, createRichMockIpc } from "./mock";
import { isTauriRuntime } from "./runtime";
import { tauriIpc } from "./tauri";

let override: IpcApi | null = null;
let browserMock: IpcApi | null = null;

/** Injection d'implémentation (tests, Playwright). `null` rétablit l'auto-détection. */
export function configureIpc(api: IpcApi | null): void {
  override = api;
}

/** Utilisé par les tests pour ne pas fuiter de mock d'un test à l'autre. */
export function resetIpc(): void {
  override = null;
  browserMock = null;
}

/**
 * Point d'entrée unique de l'IPC : Tauri en production, mock mémoire dans un
 * navigateur. Aucun composant n'appelle `invoke` directement (PLAN §1.7).
 */
export function getIpc(): IpcApi {
  if (override) return override;
  if (isTauriRuntime()) return tauriIpc;
  if (typeof window !== "undefined" && (window as any).__DAYALI_IPC__) {
    return (window as any).__DAYALI_IPC__;
  }
  if (import.meta.env.MODE === "screenshots") {
    browserMock ??= createRichMockIpc();
    return browserMock;
  }
  browserMock ??= createMockIpc();
  return browserMock;
}

export type { IpcApi } from "./api";
export { isTauriRuntime } from "./runtime";
