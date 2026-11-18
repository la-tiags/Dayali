/**
 * Repro du constat C-01 (AUDIT-LOGIQUE) : un rappel reporté de la veille qui
 * est aussi dû aujourd'hui s'affiche DEUX FOIS dans l'aperçu — une fois dans
 * « Rappels du jour », une fois dans « Report de la veille ».
 *
 * `DayPreview` ne déduplique pas `carryOvers` contre `todayReminders`
 * (visibleCarryOvers filtre seulement les `abandoned`).
 *
 * Ce test ÉCHOUE sur `main`.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DayPreview } from "../../src/features/today/DayPreview";
import type { Reminder } from "../../src/lib/contracts/types";

const duplicate: Reminder = {
  schemaVersion: 1,
  id: "00000000-0000-7000-8000-000000000003",
  listId: "00000000-0000-7000-8000-0000000000aa",
  title: "Tâche reportée",
  notes: null,
  status: "open",
  dueDate: "2026-11-12",
  dueTime: null,
  dueTimeZone: null,
  projectId: null,
  completedAt: null,
  abandonedAt: null,
  priority: null,
  recurrence: null,
  sortKey: null,
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
  machineId: "11111111-1111-7111-8111-111111111111",
};

describe("AUDIT C-01 — doublon aperçu (Rappels du jour vs Report de la veille)", () => {
  it("n'affiche qu'une seule fois un rappel présent dans les deux listes", () => {
    const { container } = render(
      <DayPreview
        locale="fr-FR"
        timeZone="Europe/Paris"
        civilDate="2026-11-12"
        logicalDate="2026-11-12"
        greeting="Bonjour"
        lastDayStartedAt="2026-11-12T06:00:00.000Z"
        reminders={[duplicate]}
        remindersStatus="ready"
        remindersError={null}
        agenda={[]}
        agendaStatus="ready"
        agendaError={null}
        agendaWarnings={[]}
        carryOvers={[duplicate]}
        carryOverWarnings={[]}
        onRetryReminders={() => {}}
        onRetryAgenda={() => {}}
        onOpenDashboard={() => {}}
      />,
    );

    const occurrences = container.textContent?.split("Tâche reportée").length ?? 0;
    // Une occurrence = 2 segments ; deux occurrences = 3 segments.
    expect(occurrences - 1).toBe(1);
  });
});
