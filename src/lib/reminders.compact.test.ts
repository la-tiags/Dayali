import { describe, expect, it } from "vitest";
import type { Reminder } from "./contracts/types";
import { compactDueLabel } from "./reminders";

const TODAY = "2026-10-27";

function reminder(dueDate: string | null, dueTime: string | null = null): Reminder {
  return { dueDate, dueTime } as Reminder;
}

describe("compactDueLabel", () => {
  it("n'affiche rien sans échéance", () => {
    expect(compactDueLabel(reminder(null), TODAY)).toBeNull();
  });

  it("utilise des mots courts autour d'aujourd'hui", () => {
    expect(compactDueLabel(reminder("2026-10-27"), TODAY)).toMatch(/^Aujourd.hui$/);
    expect(compactDueLabel(reminder("2026-10-28"), TODAY)).toBe("Demain");
    expect(compactDueLabel(reminder("2026-10-29"), TODAY)).toBe("Après-demain");
    expect(compactDueLabel(reminder("2026-10-26"), TODAY)).toBe("Hier");
    expect(compactDueLabel(reminder("2026-10-25"), TODAY)).toBe("Avant-hier");
  });

  it("passe à une date courte au-delà, avec l'année seulement si elle diffère", () => {
    expect(compactDueLabel(reminder("2026-11-02"), TODAY)).toBe("lun. 2 nov.");
    expect(compactDueLabel(reminder("2027-01-04"), TODAY)).toBe("lun. 4 janv. 2027");
  });

  it("ajoute l'heure quand elle existe", () => {
    expect(compactDueLabel(reminder("2026-10-28", "14:30"), TODAY)).toBe("Demain 14:30");
  });
});
