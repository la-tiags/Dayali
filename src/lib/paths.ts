/**
 * Chemins locaux : uniquement pour l'affichage et la composition du chemin
 * d'un nouveau vault. Aucun accès disque, aucune validation de sécurité : la
 * vérification autoritaire des chemins est en Rust (docs/PLAN.md §5.9).
 */

const WINDOWS_FORBIDDEN = /[\\/:*?"<>|]/;
/** Caractères de contrôle Unicode (catégorie `Cc`), comme `char::is_control` en Rust. */
const CONTROL_CHARS = /\p{Cc}/u;
/** Noms de périphériques réservés par Windows, avec ou sans extension (`CON`, `con.txt`…). */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

export function detectSeparator(path: string): "/" | "\\" {
  if (path.includes("/")) return "/";
  if (path.includes("\\")) return "\\";
  return "/";
}

export function isAbsolutePath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true;
  return path.startsWith("\\\\");
}

/** Compose `parent/name` (ou `parent\name` sur Windows), sans double séparateur. */
export function joinPath(parent: string, child: string): string {
  const separator = detectSeparator(parent);
  const left = parent.replace(/[\\/]+$/, "");
  const right = child.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  if (!left) return right;
  if (!right) return left;
  return `${left}${separator}${right}`;
}

/** Nom de dossier affichable depuis un chemin absolu. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

/**
 * Message d'erreur si le nom de vault est inutilisable, sinon `null`.
 *
 * Mêmes règles que `vault_create` en Rust : aucune écriture disque n'est tentée
 * avant cette validation côté UI.
 */
export function validateVaultName(name: string): string | null {
  if (name.trim() === "") return "Donnez un nom au vault.";
  if (CONTROL_CHARS.test(name)) {
    return "Le nom ne doit pas contenir de caractère de contrôle (retour à la ligne, tabulation…).";
  }
  if (name.trim() !== name) return "Le nom ne doit pas commencer ou finir par un espace.";
  if (name === "." || name === "..") return "Ce nom est réservé par le système.";
  if (WINDOWS_FORBIDDEN.test(name)) return 'Le nom ne peut pas contenir / \\ : * ? " < > |.';
  if (name.endsWith(".")) return "Le nom ne doit pas se terminer par un point.";
  const stem = name.split(".")[0]?.toUpperCase() ?? "";
  if (WINDOWS_RESERVED.test(stem)) {
    return "Ce nom est réservé par Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).";
  }
  if (new TextEncoder().encode(name).length > 255) {
    return "Le nom ne doit pas dépasser 255 octets.";
  }
  return null;
}

/** Vérification de forme d'un chemin absolu local (macOS, Linux, Windows). */
export function assertAbsolutePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("Chemin vide.");
  if (!isAbsolutePath(trimmed)) throw new Error(`Chemin absolu attendu : ${trimmed}`);
  return trimmed;
}
