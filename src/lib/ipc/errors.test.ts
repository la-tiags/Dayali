import { describe, expect, it } from "vitest";
import { IpcError, normalizeIpcError, userMessage } from "./errors";

describe("normalizeIpcError", () => {
  it("conserve un rejet structuré de Rust", () => {
    const error = normalizeIpcError({
      code: "E_PRECONDITION_FAILED",
      message: "hash mismatch",
      retryable: true,
      details: { currentRevision: "abc" },
    });
    expect(error).toEqual({
      code: "E_PRECONDITION_FAILED",
      message: "hash mismatch",
      retryable: true,
      details: { currentRevision: "abc" },
    });
  });

  it("parse un rejet sérialisé en JSON", () => {
    const error = normalizeIpcError(
      JSON.stringify({ code: "E_VAULT_NOT_OPEN", message: "no vault", retryable: false }),
    );
    expect(error.code).toBe("E_VAULT_NOT_OPEN");
    expect(error.message).toBe("no vault");
  });

  it("normalise une IpcError", () => {
    const error = normalizeIpcError(new IpcError("E_CONFLICT"));
    expect(error.code).toBe("E_CONFLICT");
    expect(error.message).toBe("Conflit détecté : aucune version n'a été écrasée.");
    expect(error.retryable).toBe(false);
  });

  it("retombe sur E_TAURI pour une chaîne non structurée", () => {
    expect(normalizeIpcError("connexion perdue").code).toBe("E_TAURI");
  });

  it("retombe sur E_INTERNAL pour une valeur inconnue", () => {
    expect(normalizeIpcError(42).code).toBe("E_INTERNAL");
    expect(normalizeIpcError(new Error("boom")).message).toBe("boom");
  });

  it("ne perd jamais le code d'une erreur connue", () => {
    for (const code of ["E_HASH_MISMATCH", "E_PATH_ESCAPE", "E_LOCK_TIMEOUT"] as const) {
      expect(normalizeIpcError({ code, message: "x" }).code).toBe(code);
    }
  });
});

describe("userMessage", () => {
  it("préfixe le libellé stable au message technique", () => {
    expect(userMessage({ code: "E_NOT_FOUND", message: "config.json", retryable: false })).toBe(
      "Fichier ou dossier introuvable. (config.json)",
    );
  });

  it("n'affiche pas deux fois le même texte", () => {
    const label = "Aucun vault n'est ouvert.";
    expect(userMessage({ code: "E_VAULT_NOT_OPEN", message: label, retryable: false })).toBe(label);
  });
});
