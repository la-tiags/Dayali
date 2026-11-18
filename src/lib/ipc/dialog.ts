import { open } from "@tauri-apps/plugin-dialog";
import { isTauriRuntime } from "./runtime";

export type DirectoryPurpose = "vault" | "parent";

export interface DirectoryPickerOptions {
  readonly purpose: DirectoryPurpose;
  readonly title?: string;
}

export type DirectoryPicker = (options: DirectoryPickerOptions) => Promise<string | null>;

const MOCK_VAULT_PATH = "/Users/mock/Documents/Dayali";
const MOCK_PARENT_PATH = "/Users/mock/Documents";

/**
 * Sélecteur de dossier. Hors Tauri (navigateur de dev/tests), chemins factices.
 * En runtime Tauri, dialogue natif `open({ directory: true })`.
 */
export const pickDirectory: DirectoryPicker = async (options) => {
  if (!isTauriRuntime()) {
    return options.purpose === "vault" ? MOCK_VAULT_PATH : MOCK_PARENT_PATH;
  }
  const selection = await open({
    directory: true,
    multiple: false,
    title:
      options.title ??
      (options.purpose === "vault" ? "Choisir un vault" : "Choisir un dossier parent"),
  });
  if (Array.isArray(selection)) return selection[0] ?? null;
  return (selection as string | null) ?? null;
};
