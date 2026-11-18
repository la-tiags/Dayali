/**
 * Erreurs IPC normalisées (docs/PLAN.md §5.8).
 *
 * Rust renvoie `Result<T, DayaliError>` ; côté JS le rejet contient l'objet
 * sérialisé `{ code, message, details?, retryable }`. Toute erreur inconnue est
 * convertie en `E_TAURI` / `E_INTERNAL` : elle n'est jamais avalée.
 */

export type ErrorCode =
  | "E_VAULT_NOT_OPEN"
  | "E_NOT_FOUND"
  | "E_PRECONDITION_FAILED"
  | "E_HASH_MISMATCH"
  | "E_CONFLICT"
  | "E_SCHEMA_INVALID"
  | "E_PERMISSION"
  | "E_DISK_FULL"
  | "E_STALE_TRANSFER"
  | "E_LOCK_TIMEOUT"
  | "E_PATH_ESCAPE"
  | "E_UNSUPPORTED"
  | "E_TAURI"
  | "E_INTERNAL";

export interface DayaliError {
  readonly code: ErrorCode;
  /** Message court, affichable, jamais de secret ni de contenu de fichier. */
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

export const ERROR_CODES: readonly ErrorCode[] = [
  "E_VAULT_NOT_OPEN",
  "E_NOT_FOUND",
  "E_PRECONDITION_FAILED",
  "E_HASH_MISMATCH",
  "E_CONFLICT",
  "E_SCHEMA_INVALID",
  "E_PERMISSION",
  "E_DISK_FULL",
  "E_STALE_TRANSFER",
  "E_LOCK_TIMEOUT",
  "E_PATH_ESCAPE",
  "E_UNSUPPORTED",
  "E_TAURI",
  "E_INTERNAL",
];

/** Libellés français des états d'erreur (l'UI parle français, les codes restent anglais). */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  E_VAULT_NOT_OPEN: "Aucun vault n'est ouvert.",
  E_NOT_FOUND: "Fichier ou dossier introuvable.",
  E_PRECONDITION_FAILED: "Le fichier a changé entre-temps : rien n'a été écrasé.",
  E_HASH_MISMATCH: "L'empreinte du fichier ne correspond pas à celle attendue.",
  E_CONFLICT: "Conflit détecté : aucune version n'a été écrasée.",
  E_SCHEMA_INVALID: "Les données du vault ne respectent pas le schéma attendu.",
  E_PERMISSION: "Permission refusée sur ce fichier ou ce dossier.",
  E_DISK_FULL: "Espace disque insuffisant.",
  E_STALE_TRANSFER: "Ce transfert semble abandonné.",
  E_LOCK_TIMEOUT: "Le fichier est utilisé par une autre opération.",
  E_PATH_ESCAPE: "Chemin refusé : il sort du vault.",
  E_UNSUPPORTED: "Cette opération n'est pas prise en charge.",
  E_TAURI: "Communication impossible avec l'application.",
  E_INTERNAL: "Erreur interne de l'application.",
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export function isDayaliError(value: unknown): value is DayaliError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isErrorCode(candidate.code) && typeof candidate.message === "string";
}

/** Erreur levée par l'implémentation mock (et par les gardes locales). */
export class IpcError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(
      message ?? ERROR_MESSAGES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "IpcError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details) this.details = options.details;
  }

  toDayaliError(): DayaliError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Normalise n'importe quelle erreur (rejet Tauri objet, chaîne JSON, `Error`
 * avec `code`, valeur inconnue) en `DayaliError` affichable.
 */
export function normalizeIpcError(error: unknown): DayaliError {
  if (error instanceof IpcError) return error.toDayaliError();

  if (typeof error === "string") {
    const parsed = parseJson(error);
    if (parsed !== null) return normalizeIpcError(parsed);
    return {
      code: "E_TAURI",
      message: error.trim() ? error : ERROR_MESSAGES.E_TAURI,
      retryable: true,
    };
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (isErrorCode(candidate.code)) {
      return {
        code: candidate.code,
        message:
          typeof candidate.message === "string" && candidate.message.trim()
            ? candidate.message
            : ERROR_MESSAGES[candidate.code],
        retryable: candidate.retryable === true,
        ...(typeof candidate.details === "object" && candidate.details !== null
          ? { details: candidate.details as Record<string, unknown> }
          : {}),
      };
    }
    if (error instanceof Error) {
      return {
        code: "E_INTERNAL",
        message: error.message || ERROR_MESSAGES.E_INTERNAL,
        retryable: false,
      };
    }
  }

  return { code: "E_INTERNAL", message: ERROR_MESSAGES.E_INTERNAL, retryable: false };
}

/** Message utilisateur : libellé stable par code, message technique en second plan. */
export function userMessage(error: DayaliError): string {
  const label = ERROR_MESSAGES[error.code];
  if (!error.message || error.message === label) return label;
  return `${label} (${error.message})`;
}
