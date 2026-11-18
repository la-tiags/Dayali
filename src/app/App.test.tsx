import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MachineLocal } from "../lib/contracts/types";
import { configureIpc, resetIpc } from "../lib/ipc";
import { createMockIpc, MOCK_MACHINE_ID } from "../lib/ipc/mock";
import { resetAppStore } from "../stores/app.store";
import { App } from "./App";

const VAULT = "/Users/mock/Documents/Dayali";

function machineLocal(overrides: Partial<MachineLocal> = {}): MachineLocal {
  return {
    schemaVersion: 1,
    machineId: MOCK_MACHINE_ID,
    createdAt: "2026-10-20T07:05:00.000Z",
    lastVaultPath: null,
    recentVaults: [],
    ...overrides,
  };
}

afterEach(() => {
  resetAppStore();
  resetIpc();
  window.location.hash = "";
});

describe("App — entrée réelle", () => {
  it("ouvre le dernier vault au lancement au lieu de rester sur l'écran de choix", async () => {
    configureIpc(
      createMockIpc({
        machineLocal: machineLocal({ lastVaultPath: VAULT, recentVaults: [VAULT] }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: "Démarrer la journée" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Votre journée, vos fichiers/ }),
    ).not.toBeInTheDocument();
  });
});
