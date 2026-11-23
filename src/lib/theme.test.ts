import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  applyAppearance,
  DEFAULT_ACCENT,
  isThemeChoice,
  normalizeAccent,
} from "./theme";

function createRoot() {
  return document.createElement("div");
}

describe("presets de couleur", () => {
  it("propose des identifiants uniques et des couleurs hexadécimales valides", () => {
    const ids = new Set(ACCENT_PRESETS.map((preset) => preset.id));
    expect(ids.size).toBe(ACCENT_PRESETS.length);
    expect(ACCENT_PRESETS.length).toBeGreaterThanOrEqual(3);
    for (const preset of ACCENT_PRESETS) {
      expect(preset.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  it("inclut l'accent par défaut", () => {
    expect(ACCENT_PRESETS.some((preset) => preset.accent === DEFAULT_ACCENT)).toBe(true);
  });
});

describe("normalizeAccent", () => {
  it("garde une couleur valide en minuscules", () => {
    expect(normalizeAccent("#C2703D")).toBe("#c2703d");
  });

  it("retombe sur l'accent par défaut pour une valeur absente ou invalide", () => {
    expect(normalizeAccent(undefined)).toBe(DEFAULT_ACCENT);
    expect(normalizeAccent(null)).toBe(DEFAULT_ACCENT);
    expect(normalizeAccent("#abc")).toBe(DEFAULT_ACCENT);
    expect(normalizeAccent("orange")).toBe(DEFAULT_ACCENT);
  });
});

describe("isThemeChoice", () => {
  it("reconnaît les trois valeurs du schéma", () => {
    expect(isThemeChoice("auto")).toBe(true);
    expect(isThemeChoice("light")).toBe(true);
    expect(isThemeChoice("dark")).toBe(true);
    expect(isThemeChoice("sombre")).toBe(false);
    expect(isThemeChoice(undefined)).toBe(false);
  });
});

describe("applyAppearance", () => {
  it("pose data-scheme pour un choix explicite", () => {
    const root = createRoot();
    applyAppearance(root, { theme: "light", accentColor: "#c2703d" });
    expect(root.dataset.scheme).toBe("light");
    expect(root.style.getPropertyValue("--accent-base")).toBe("#c2703d");

    applyAppearance(root, { theme: "dark" });
    expect(root.dataset.scheme).toBe("dark");
  });

  it("retire data-scheme en mode automatique", () => {
    const root = createRoot();
    applyAppearance(root, { theme: "light", accentColor: "#c2703d" });
    expect(root.dataset.scheme).toBe("light");

    applyAppearance(root, { theme: "auto", accentColor: "#c2703d" });
    expect(root.dataset.scheme).toBeUndefined();
    expect(root.hasAttribute("data-scheme")).toBe(false);
  });

  it("applique l'accent par défaut si la config n'en fournit pas", () => {
    const root = createRoot();
    applyAppearance(root, {});
    expect(root.style.getPropertyValue("--accent-base")).toBe(DEFAULT_ACCENT);
  });
});
