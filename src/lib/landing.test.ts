import { describe, expect, it } from "vitest";
import { resolveLanding } from "./landing";

describe("resolveLanding", () => {
  it("sans vault → écran de choix", () => {
    expect(
      resolveLanding({ hasVault: false, openDashboardOnLaunch: false, startedToday: false }),
    ).toBe("/setup");
    expect(
      resolveLanding({ hasVault: false, openDashboardOnLaunch: true, startedToday: true }),
    ).toBe("/setup");
  });

  it("openDashboardOnLaunch=true saute l'accueil", () => {
    expect(
      resolveLanding({ hasVault: true, openDashboardOnLaunch: true, startedToday: false }),
    ).toBe("/dashboard");
  });

  it("journée déjà démarrée → dashboard (accueil une seule fois par journée)", () => {
    expect(
      resolveLanding({ hasVault: true, openDashboardOnLaunch: false, startedToday: true }),
    ).toBe("/dashboard");
  });

  it("première ouverture de la journée → accueil", () => {
    expect(
      resolveLanding({ hasVault: true, openDashboardOnLaunch: false, startedToday: false }),
    ).toBe("/today");
  });
});
