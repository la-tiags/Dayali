import { describe, expect, it } from "vitest";
import { baseName, isAbsolutePath, joinPath, validateVaultName } from "./paths";

describe("joinPath", () => {
  it("compose un chemin POSIX sans double séparateur", () => {
    expect(joinPath("/Users/alice/Documents", "Dayali")).toBe("/Users/alice/Documents/Dayali");
    expect(joinPath("/Users/alice/Documents/", "/Dayali/")).toBe("/Users/alice/Documents/Dayali");
  });

  it("conserve le séparateur Windows", () => {
    expect(joinPath("C:\\Users\\alice\\Documents", "Dayali")).toBe(
      "C:\\Users\\alice\\Documents\\Dayali",
    );
  });

  it("gère un parent vide", () => {
    expect(joinPath("", "Dayali")).toBe("Dayali");
  });
});

describe("baseName", () => {
  it("extrait le dernier segment", () => {
    expect(baseName("/Users/alice/Documents/Dayali")).toBe("Dayali");
    expect(baseName("/Users/alice/Documents/Dayali/")).toBe("Dayali");
    expect(baseName("C:\\Users\\alice\\Dayali")).toBe("Dayali");
  });
});

describe("isAbsolutePath", () => {
  it("reconnaît les chemins absolus des trois OS", () => {
    expect(isAbsolutePath("/Users/alice")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\alice")).toBe(true);
    expect(isAbsolutePath("\\\\serveur\\partage")).toBe(true);
    expect(isAbsolutePath("Documents/Dayali")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});

describe("validateVaultName", () => {
  it("accepte un nom simple", () => {
    expect(validateVaultName("Dayali")).toBeNull();
    expect(validateVaultName("Vault 2026")).toBeNull();
  });

  it("refuse un nom vide, réservé ou invalide sur Windows", () => {
    expect(validateVaultName("")).not.toBeNull();
    expect(validateVaultName("   ")).not.toBeNull();
    expect(validateVaultName(".")).not.toBeNull();
    expect(validateVaultName("..")).not.toBeNull();
    expect(validateVaultName("a/b")).not.toBeNull();
    expect(validateVaultName("a:b")).not.toBeNull();
    expect(validateVaultName("fin.")).not.toBeNull();
    expect(validateVaultName("CON")).not.toBeNull();
    expect(validateVaultName("com1.txt")).not.toBeNull();
    expect(validateVaultName(" Travail")).not.toBeNull();
    expect(validateVaultName("Travail ")).not.toBeNull();
    expect(validateVaultName("x".repeat(255))).toBeNull();
    expect(validateVaultName("x".repeat(256))).not.toBeNull();
    // La limite est en octets UTF-8, pas en caractères.
    expect(validateVaultName("é".repeat(127))).toBeNull();
    expect(validateVaultName("é".repeat(128))).not.toBeNull();
  });

  it("refuse les caractères de contrôle, comme char::is_control en Rust", () => {
    expect(validateVaultName("a\u0000b")).toMatch(/contrôle/i);
    expect(validateVaultName("Travail\n")).toMatch(/contrôle/i);
    expect(validateVaultName("Tra\tvail")).toMatch(/contrôle/i);
    expect(validateVaultName("\u0007")).not.toBeNull();
    expect(validateVaultName("Vault\u007f")).toMatch(/contrôle/i);
    expect(validateVaultName("Vault\u0085")).toMatch(/contrôle/i);
    // Un nom vide reste signalé comme vide, pas comme un caractère de contrôle.
    expect(validateVaultName("\n")).toBe("Donnez un nom au vault.");
    // Les accents et caractères Unicode imprimables restent acceptés.
    expect(validateVaultName("Travail café")).toBeNull();
  });
});
