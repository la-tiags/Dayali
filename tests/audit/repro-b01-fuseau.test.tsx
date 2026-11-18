/**
 * Repro du constat B-01 (AUDIT-LOGIQUE) : une échéance stockée en UTC n'est
 * pas convertie vers le fuseau d'affichage. Le libellé affiche l'heure brute.
 *
 * Cas de la demande : échéance `2026-11-12T11:00:00Z` doit s'afficher 12:00
 * à Paris (hiver, UTC+1). Le code affiche 11:00.
 *
 * Ce test ÉCHOUE sur `main` : il constitue la preuve du défaut.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DayPreview } from "../../src/features/today/DayPreview";
import type { Reminder } from "../../src/lib/contracts/types";

function utcReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    schemaVersion: 1,
    id: "00000000-0000-7000-8000-000000000001",
    listId: "00000000-0000-7000-8000-0000000000aa",
    title: "Rappel UTC",
    notes: null,
    status: "open",
    dueDate: "2026-11-12",
    dueTime: "11:00",
    dueTimeZone: "UTC",
    projectId: null,
    completedAt: null,
    abandonedAt: null,
    priority: null,
    recurrence: null,
    sortKey: null,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    machineId: "11111111-1111-7111-8111-111111111111",
    ...overrides,
  };
}

describe("AUDIT B-01 — conversion de fuseau des échéances", () => {
  it("affiche 12:00 à Paris pour une échéance 2026-11-12T11:00:00Z (hiver, UTC+1)", () => {
    render(
      <DayPreview
        locale="fr-FR"
        timeZone="Europe/Paris"
        civilDate="2026-11-12"
        logicalDate="2026-11-12"
        greeting="Bonjour"
        lastDayStartedAt="2026-11-12T06:00:00.000Z"
        reminders={[utcReminder()]}
        remindersStatus="ready"
        remindersError={null}
        agenda={[]}
        agendaStatus="ready"
        agendaError={null}
        agendaWarnings={[]}
        carryOvers={[]}
        carryOverWarnings={[]}
        onRetryReminders={() => {}}
        onRetryAgenda={() => {}}
        onOpenDashboard={() => {}}
      />,
    );

    const item = screen.getByText("Rappel UTC").closest("li");
    expect(item).not.toBeNull();
    // Attendu métier : 11:00 UTC == 12:00 Europe/Paris en novembre.
    expect(item?.textContent).toContain("12:00");
    expect(item?.textContent).not.toContain("11:00");
  });
});
