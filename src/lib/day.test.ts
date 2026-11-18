import { describe, expect, it } from "vitest";
import dayCases from "../../tests/fixtures/day-cases.json";
import { greetingFor, logicalDay } from "./day";

describe("logicalDay (day-cases.json)", () => {
  for (const c of dayCases.cases) {
    it(c.id, () => {
      expect(logicalDay(c.instant, c.dayStartHour, c.timeZone)).toBe(c.expectedDate);
    });
  }
});

describe("logicalDay edge cases", () => {
  it("03:59 Europe/Paris → journée précédente", () => {
    expect(logicalDay("2026-10-27T02:59:00.000Z", 4, "Europe/Paris")).toBe("2026-10-26");
  });
  it("04:00 Europe/Paris → nouvelle journée", () => {
    expect(logicalDay("2026-10-27T03:00:00.000Z", 4, "Europe/Paris")).toBe("2026-10-27");
  });
});

describe("greetingFor", () => {
  it("matin", () => expect(greetingFor(9)).toBe("Bonjour"));
  it("soir", () => expect(greetingFor(20)).toBe("Bonsoir"));
});
