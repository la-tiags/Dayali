import { describe, expect, it } from "vitest";
import quotes from "../../assets/quotes-fr.json";

interface Translation {
  readonly from: string;
  readonly translator: string;
  readonly edition: string;
  readonly rights: string;
}

interface Quote {
  readonly text: string;
  readonly author: string;
  readonly source: string;
  readonly sourceDetail: string;
  readonly sourceUrl: string;
  readonly translation: Translation | null;
  readonly translationRights: string;
  readonly authorDeathYear: number;
}

const QUOTES = quotes as readonly Quote[];

/** Normalisation : minuscules, apostrophes typographiques, ponctuation, espaces. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘‛`´]/g, "'")
    .replace(/[«»“”"]/g, "")
    .replace(/[.,;:!?…—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Un statut de droits « clair » est un statut renseigné qui ne signale pas
 * lui-même une incertitude. Une traduction dont les droits seraient inconnus
 * ou à déterminer doit être retirée du corpus, pas seulement documentée.
 */
function isClearRightsStatus(value: string): boolean {
  const status = value.trim().toLowerCase();
  if (status.length === 0) return false;
  return !/(inconnu|incertain|non vérifié|non verifie|à déterminer|a determiner|sous réserve)/.test(
    status,
  );
}

describe("citations françaises embarquées", () => {
  it("contient 37 textes distincts", () => {
    expect(QUOTES).toHaveLength(37);
  });

  it("n'a aucun texte dupliqué après normalisation", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const quote of QUOTES) {
      const key = normalize(quote.text);
      if (seen.has(key)) duplicates.push(quote.text);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(QUOTES.length);
  });

  it("a des textes, auteurs et sources non vides", () => {
    for (const quote of QUOTES) {
      expect(quote.text.trim()).not.toBe("");
      expect(quote.author.trim()).not.toBe("");
      expect(quote.source.trim()).not.toBe("");
      expect(quote.sourceDetail.trim()).not.toBe("");
    }
  });

  it("n'a aucune citation faite uniquement d'espaces", () => {
    for (const quote of QUOTES) {
      expect(quote.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("ne cite que des auteurs du domaine public (décès <= 1955)", () => {
    for (const quote of QUOTES) {
      expect(Number.isInteger(quote.authorDeathYear)).toBe(true);
      expect(quote.authorDeathYear).toBeLessThanOrEqual(1955);
    }
  });

  it("a une URL de source HTTPS qui pointe vers fr.wikiquote.org", () => {
    for (const quote of QUOTES) {
      const url = new URL(quote.sourceUrl);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("fr.wikiquote.org");
    }
  });

  it("déclare explicitement s'il s'agit d'une traduction", () => {
    for (const quote of QUOTES) {
      expect(quote.translation === null || typeof quote.translation === "object").toBe(true);
    }
  });

  it("a un statut de droits de traduction non vide et clair pour chaque citation", () => {
    for (const quote of QUOTES) {
      expect(isClearRightsStatus(quote.translationRights)).toBe(true);
    }
  });

  it("fournit toutes les métadonnées dès qu'une citation est une traduction", () => {
    for (const quote of QUOTES) {
      if (quote.translation === null) continue;

      expect(quote.translation.from.trim()).not.toBe("");
      expect(quote.translation.translator.trim()).not.toBe("");
      expect(quote.translation.edition.trim()).not.toBe("");
      expect(isClearRightsStatus(quote.translation.rights)).toBe(true);
      expect(isClearRightsStatus(quote.translationRights)).toBe(true);
    }
  });
});
