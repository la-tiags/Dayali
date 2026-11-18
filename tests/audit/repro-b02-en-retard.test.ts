/**
 * Repro du constat B-02 (AUDIT-LOGIQUE) : « En retard » ignore l'heure et le
 * fuseau. `isOverdue` ne compare que `dueDate < logicalDay`.
 *
 * Conséquence : un rappel dû aujourd'hui à 09:00 n'est jamais « en retard »
 * à 18:00 ; et une échéance due à 23:00 est « en retard » dès 05:00.
 *
 * Fix : isOverdue accepte désormais `now` en 3e paramètre optionnel.
 */
import { describe, expect, it } from "vitest";
import type { Reminder } from "../../src/lib/contracts/types";
import { isOverdue } from "../../src/lib/reminders";

const base: Reminder = {
  schemaVersion: 1,
  id: "00000000-0000-7000-8000-000000000002",
  listId: "00000000-0000-7000-8000-0000000000aa",
  title: "Rappel du jour",
  notes: null,
  status: "open",
  dueDate: "2026-11-12",
  dueTime: "09:00",
  dueTimeZone: "Europe/Paris",
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

describe("AUDIT B-02 — calcul « En retard »", () => {
  it("un rappel dû aujourd'hui à 09:00 est en retard à 18:00", () => {
    // 2026-11-12T18:00:00+01:00 = 2026-11-12T17:00:00Z
    // On utilise getTime() pour éviter toute dépendance au TZ du runner.
    const now = new Date("2026-11-12T18:00:00+01:00");
    expect(now.getTime()).toBe(new Date("2026-11-12T17:00:00Z").getTime());
    const sameLogicalDay = "2026-11-12";

    // Sans l'instant courant, seul le jour logique est comparé → pas en retard.
    expect(isOverdue(base, sameLogicalDay)).toBe(false);

    // Avec l'instant courant (18:00 Paris > 09:00 Paris) → en retard.
    expect(isOverdue(base, sameLogicalDay, now)).toBe(true);
  });
});
