import { isTauriRuntime } from "./ipc/runtime";

/**
 * Ouvre un lien externe dans le navigateur du système. En production, passe par
 * le plugin Tauri `opener` (aucune navigation interne, aucune fenêtre WebView
 * supplémentaire) ; en navigateur de dev, `window.open` suffit.
 */
export async function openExternal(url: string): Promise<void> {
  if (!/^https:\/\//i.test(url)) return;
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
