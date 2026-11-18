/** Détection du runtime : l'app tourne dans Tauri 2 ou dans un navigateur de dev. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
