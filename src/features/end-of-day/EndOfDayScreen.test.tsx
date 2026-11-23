import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../../lib/contracts/types";
import { configureIpc, resetIpc } from "../../lib/ipc";
import { createMockIpc, MOCK_MACHINE_ID } from "../../lib/ipc/mock";
import { resetAppStore, useAppStore } from "../../stores/app.store";
import { EndOfDayScreen } from "./EndOfDayScreen";

const VAULT = "/Users/mock/Documents/Dayali";
const NOW = new Date("2026-10-27T09:00:00.000Z");

describe("EndOfDayScreen", () => {
  const MOCK_REMINDER: Reminder = {
    schemaVersion: 1,
    id: "rem-1",
    listId: "list-1",
    title: "Tâche test 1",
    notes: null,
    status: "open",
    dueDate: "2026-10-26",
    dueTime: null,
    dueTimeZone: null,
    projectId: null,
    completedAt: null,
    recurrence: null,
    sortKey: null,
    abandonedAt: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    machineId: MOCK_MACHINE_ID,
  };

  beforeEach(() => {
    resetAppStore();
    resetIpc();
  });

  afterEach(() => {
    resetAppStore();
    resetIpc();
  });

  function next(times = 1) {
    for (let i = 0; i < times; i++) {
      fireEvent.click(screen.getByRole("button", { name: /Suivant/i }));
    }
  }

  async function seed(items: Reminder[] = [MOCK_REMINDER]) {
    const ipc = createMockIpc({
      timeZone: "Europe/Paris",
      now: () => NOW,
      moduleData: { reminders: items },
    });
    configureIpc(ipc);
    await ipc.vaultOpen({ path: VAULT });
    useAppStore.setState({
      vault: {
        root: VAULT,
        name: "Dayali",
        machineId: MOCK_MACHINE_ID,
        configRevision: "0".repeat(64),
      },
    });
    return ipc;
  }

  it("render screen, lists reminders and calendar, and handles actions (tomorrow, abandon)", async () => {
    await seed([MOCK_REMINDER]);

    render(
      <MemoryRouter>
        <EndOfDayScreen now={NOW} timeZone="Europe/Paris" locale="fr-FR" logicalDate="2026-10-26" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Fin de journée" })).toBeInTheDocument();
    next();
    expect(await screen.findByText("Tâche test 1")).toBeInTheDocument();

    const reportBtn = screen.getByRole("button", { name: /Reporter à demain : Tâche test 1/i });
    fireEvent.click(reportBtn);

    await waitFor(() => {
      expect(screen.getByText("[Reportée à demain]")).toBeInTheDocument();
    });

    const abandonBtn = screen.getByRole("button", { name: /Abandonner : Tâche test 1/i });
    fireEvent.click(abandonBtn);

    await waitFor(() => {
      expect(screen.getByText("Tâches abandonnées (1)")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Restaurer Tâche test 1/i })).toBeInTheDocument();
    });
  });

  it("handles partial errors when reminderReport fails", async () => {
    const ipc = await seed([MOCK_REMINDER]);
    vi.spyOn(ipc, "reminderReport").mockRejectedValueOnce(new Error("E_PRECONDITION_FAILED"));

    render(
      <MemoryRouter>
        <EndOfDayScreen now={NOW} timeZone="Europe/Paris" locale="fr-FR" logicalDate="2026-10-26" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Fin de journée" })).toBeInTheDocument();
    next();
    expect(await screen.findByText("Tâche test 1")).toBeInTheDocument();

    const reportBtn = screen.getByRole("button", { name: /Reporter à demain : Tâche test 1/i });
    fireEvent.click(reportBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/E_PRECONDITION_FAILED|Conflit/i);
    });
  });

  it("supports quick add tasks for tomorrow and finishing evening", async () => {
    await seed([MOCK_REMINDER]);

    render(
      <MemoryRouter>
        <EndOfDayScreen now={NOW} timeZone="Europe/Paris" locale="fr-FR" logicalDate="2026-10-26" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Fin de journée" })).toBeInTheDocument();
    next(2);

    const input = screen.getByLabelText(/Ajouter une tâche/i);
    fireEvent.change(input, { target: { value: "Nouvelle tâche demain" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", charCode: 13 });

    expect(await screen.findByText("Nouvelle tâche demain")).toBeInTheDocument();

    next();
    expect(await screen.findByRole("heading", { name: "Bilan de la journée" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Agenda de demain/i })).toBeInTheDocument();

    const finishBtn = screen.getByRole("button", { name: /Bonne soirée/i });
    fireEvent.click(finishBtn);

    expect(await screen.findByRole("heading", { name: "Bonne soirée ! 🌙" })).toBeInTheDocument();
    // L'écran de clôture ne garde que « Bonne soirée » et le retour au dashboard.
    expect(screen.queryByRole("heading", { name: "Bilan de la journée" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Agenda de demain/i })).toBeNull();
    expect(screen.queryByText(/est enregistré/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Retour au dashboard/i })).toBeInTheDocument();
  });

  it("lists only the tasks completed during the current day on the first step", async () => {
    await seed([
      {
        ...MOCK_REMINDER,
        id: "done-today",
        title: "Faite aujourd'hui",
        status: "done",
        completedAt: "2026-10-26T10:00:00.000Z",
      },
      {
        ...MOCK_REMINDER,
        id: "done-before",
        title: "Faite la semaine dernière",
        status: "done",
        completedAt: "2026-10-19T10:00:00.000Z",
      },
    ]);

    render(
      <MemoryRouter>
        <EndOfDayScreen now={NOW} timeZone="Europe/Paris" locale="fr-FR" logicalDate="2026-10-26" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Faite aujourd'hui")).toBeInTheDocument();
    expect(screen.queryByText("Faite la semaine dernière")).toBeNull();
  });
});
