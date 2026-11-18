import { describe, expect, it } from "vitest";
import { homePhotos, photoOfTheDay } from "./photos";

const CC0_DEED = "https://creativecommons.org/publicdomain/zero/1.0/deed.en";

describe("photos d'accueil embarquées", () => {
  it("contient exactement 4 photos", () => {
    expect(homePhotos).toHaveLength(4);
  });

  it("embarque 4 fichiers distincts", () => {
    const sources = homePhotos.map((photo) => photo.src);
    expect(new Set(sources).size).toBe(homePhotos.length);
    for (const src of sources) {
      expect(src.trim()).not.toBe("");
    }
  });

  it("a des crédits, licences et URLs de licence non vides", () => {
    for (const photo of homePhotos) {
      expect(photo.credit.trim()).not.toBe("");
      expect(photo.license.trim()).not.toBe("");
      expect(photo.licenseUrl.trim()).not.toBe("");
    }
  });

  it("n'utilise que la licence CC0 1.0 avec le texte exact", () => {
    for (const photo of homePhotos) {
      expect(photo.license).toBe("CC0 1.0");
      expect(photo.licenseUrl).toBe(CC0_DEED);
    }
  });

  it("pointe vers une page source Commons en HTTPS", () => {
    for (const photo of homePhotos) {
      const url = new URL(photo.source);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("commons.wikimedia.org");
      expect(url.pathname.startsWith("/wiki/File:")).toBe(true);
    }
  });

  it("liste les quatre photographes exacts", () => {
    expect(homePhotos.map((photo) => photo.credit)).toEqual([
      "Salvatore Gerace",
      "Romain Guy",
      "David Marcu",
      "Agnes Monkelbaan",
    ]);
  });

  it("sélectionne la photo du jour de façon cyclique et déterministe", () => {
    expect(photoOfTheDay(0)).toBe(homePhotos[0]);
    expect(photoOfTheDay(1)).toBe(homePhotos[1]);
    expect(photoOfTheDay(2)).toBe(homePhotos[2]);
    expect(photoOfTheDay(3)).toBe(homePhotos[3]);
    expect(photoOfTheDay(4)).toBe(homePhotos[0]);
    expect(photoOfTheDay(1)).toBe(photoOfTheDay(1));
    expect(photoOfTheDay(366)).toBe(homePhotos[2]);
  });

  it("normalise un seed négatif dans [0, 4)", () => {
    expect(photoOfTheDay(-1)).toBe(homePhotos[3]);
    expect(photoOfTheDay(-4)).toBe(homePhotos[0]);
    expect(photoOfTheDay(-5)).toBe(homePhotos[3]);
    expect(photoOfTheDay(0)).toBe(homePhotos[0]);
  });

  it("ne renvoie jamais undefined, même hors bornes", () => {
    for (const seed of [-10_000, -1, 0, 1, 10_000, Number.MAX_SAFE_INTEGER]) {
      const photo = photoOfTheDay(seed);
      expect(photo).toBeDefined();
      expect(homePhotos).toContain(photo);
    }
  });
});
