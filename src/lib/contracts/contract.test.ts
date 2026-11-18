import { describe, expect, it } from "vitest";
import { machineSchema } from "../schemas/generated/machine";

const machine = {
  schemaVersion: 1,
  machineId: "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
  name: "Test machine",
  platform: "macos",
  arch: "arm64",
  appVersion: "0.1.0",
  createdAt: "2026-10-20T07:05:00.000Z",
  lastSeenAt: "2026-10-26T21:42:00.000Z",
  transfers: [],
  localState: {
    lastDayStartDate: null,
    lastDayStartedAt: null,
    lateNightShownFor: null,
    reminderHistory: [],
    homeImageFolder: null,
    lastFullScanAt: null,
  },
};

describe("contrat E1/E2 machine", () => {
  it("accepte reminderHistory et détecte le retour de carryOvers", () => {
    expect(machineSchema.safeParse(machine).success).toBe(true);
    const divergent = structuredClone(machine) as typeof machine & {
      localState: Record<string, unknown>;
    };
    const state = divergent.localState as Record<string, unknown>;
    delete state.reminderHistory;
    state.carryOvers = [];
    expect(machineSchema.safeParse(divergent).success).toBe(false);
  });

  it("accepte expectedHash et les états pending/applied du rapport Rust", () => {
    const withHistory = structuredClone(machine) as typeof machine & {
      localState: Record<string, unknown>;
    };
    (withHistory.localState as Record<string, unknown>).reminderHistory = [
      {
        id: "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5c",
        reminderId: "0199a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5d",
        action: "abandon",
        sourceDay: "2026-10-27",
        logicalDay: "2026-10-28",
        dueDate: "2026-10-27",
        newDueDate: null,
        expectedHash: "a".repeat(64),
        createdAt: "2026-10-28T09:00:00.000Z",
        resolvedAt: null,
        status: "pending",
      },
    ];
    expect(machineSchema.safeParse(withHistory).success).toBe(true);
  });
});
