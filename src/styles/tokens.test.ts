import { describe, expect, it } from "vitest";

function parseHex(hex: string): [number, number, number] {
  let clean = hex.replace("#", "");
  if (clean.length === 3) {
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = Number.parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Design Tokens Contrast (WCAG AA)", () => {
  const creamBg = "#faf6ee";
  const headingText = "#1a1611";
  const mainText = "#241f18";
  const mutedText = "#5b5347";

  it("heading text on cream background meets WCAG AA large text (>= 3:1)", () => {
    const ratio = contrastRatio(headingText, creamBg);
    expect(ratio).toBeGreaterThanOrEqual(3.0);
  });

  it("main text on cream background meets WCAG AA normal text (>= 4.5:1)", () => {
    const ratio = contrastRatio(mainText, creamBg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("muted text on cream background meets WCAG AA normal text (>= 4.5:1)", () => {
    const ratio = contrastRatio(mutedText, creamBg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
