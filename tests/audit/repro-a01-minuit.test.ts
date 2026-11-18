/**
 * Repro du constat A-01 (AUDIT-LOGIQUE) : entre minuit et 4 h, la date civile
 * affichée et la date logique divergent, et l'aperçu les affiche toutes deux.
 *
 * `DayPreview` affiche `civilDate` dans l'eyebrow et `logicalDate` dans la
 * ligne « Journée du … ». À 02:00, l'utilisateur voit donc deux dates
 * différentes à l'écran.
 *
 * Ce test passe (il documente le comportement réel) et sert de preuve.
 */
import { describe, expect, it } from "vitest";
import { formatLocalDate, logicalDay } from "../../src/lib/day";

describe("AUDIT A-01 — minuit → 4 h", () => {
  it("à 02:00 heure de Paris, la date civile est J et la date logique J-1", () => {
    const instant = "2026-11-13T01:00:00.000Z"; // 02:00 Paris (hiver, UTC+1)
    const civil = formatLocalDate(instant, "Europe/Paris");
    const logical = logicalDay(instant, 4, "Europe/Paris");
    expect(civil).toBe("2026-11-13");
    expect(logical).toBe("2026-11-12");
    // Divergence affichée simultanément dans l'aperçu.
    expect(civil).not.toBe(logical);
  });
});
