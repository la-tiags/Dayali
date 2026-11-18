import { describe, expect, it } from "vitest";
import type { ReminderList } from "../contracts/types";
import { createMockIpc, MOCK_MACHINE_ID } from "./mock";

const PARIS = "Europe/Paris";

const LIST: ReminderList = {
  schemaVersion: 1,
  id: "list-todo",
  name: "À faire",
  color: null,
  order: 0,
  archived: false,
  createdAt: "2026-10-20T07:10:00.000Z",
  updatedAt: "2026-10-20T07:10:00.000Z",
  machineId: MOCK_MACHINE_ID,
};

const STALE_HASH = "a".repeat(64);

function fixedClock(start: string) {
  let current = new Date(start);
  return {
    now: () => current,
    set: (value: string) => {
      current = new Date(value);
    },
  };
}

describe("mock IPC — vault et machine locale", () => {
  it("ouvre un vault, le mémorise hors vault et déduplique les récents", async () => {
    const ipc = createMockIpc();
    await ipc.vaultOpen({ path: "/Users/mock/Documents/Dayali" });
    let machineLocal = await ipc.machineLocalGet();
    expect(machineLocal.lastVaultPath).toBe("/Users/mock/Documents/Dayali");
    expect(machineLocal.recentVaults).toEqual(["/Users/mock/Documents/Dayali"]);
    expect(machineLocal.machineId).toBe(MOCK_MACHINE_ID);

    await ipc.vaultOpen({ path: "/Volumes/Partage/Dayali" });
    await ipc.vaultOpen({ path: "/Users/mock/Documents/Dayali" });
    machineLocal = await ipc.machineLocalGet();
    expect(machineLocal.recentVaults).toEqual([
      "/Users/mock/Documents/Dayali",
      "/Volumes/Partage/Dayali",
    ]);
    expect(machineLocal.lastVaultPath).toBe(machineLocal.recentVaults[0]);
  });

  it("plafonne les vaults récents à 10", async () => {
    const ipc = createMockIpc();
    for (let index = 0; index < 12; index += 1) {
      await ipc.vaultOpen({ path: `/vaults/v${index}` });
    }
    const machineLocal = await ipc.machineLocalGet();
    expect(machineLocal.recentVaults).toHaveLength(10);
    expect(machineLocal.recentVaults[0]).toBe("/vaults/v11");
  });

  it("refuse config/day sans vault ouvert", async () => {
    const ipc = createMockIpc();
    await expect(ipc.configGet()).rejects.toMatchObject({ code: "E_VAULT_NOT_OPEN" });
    await expect(ipc.dayStateGet()).rejects.toMatchObject({ code: "E_VAULT_NOT_OPEN" });
  });
});

describe("mock IPC — préconditions des listes de rappels", () => {
  it("crée une nouvelle liste sans précondition", async () => {
    const ipc = createMockIpc({ moduleData: { lists: [LIST] } });
    const created = await ipc.reminderListSave({
      list: { ...LIST, id: "list-perso", name: "Perso" },
    });
    expect(created.name).toBe("Perso");
    const lists = await ipc.reminderListDefs();
    expect(lists.map((list) => list.id)).toEqual([LIST.id, "list-perso"]);
  });

  it("refuse de modifier une liste existante sans hash, sans rien changer", async () => {
    const ipc = createMockIpc({ moduleData: { lists: [LIST] } });
    await expect(
      ipc.reminderListSave({ list: { ...LIST, name: "Renommée" } }),
    ).rejects.toMatchObject({ code: "E_PRECONDITION_FAILED" });

    const lists = await ipc.reminderListDefs();
    expect(lists[0]?.name).toBe("À faire");
  });

  it("refuse un hash périmé et n'écrase pas la version du vault", async () => {
    const ipc = createMockIpc({ moduleData: { lists: [LIST] } });
    await expect(
      ipc.reminderListSave({
        list: { ...LIST, name: "Renommée" },
        expected: STALE_HASH,
      }),
    ).rejects.toMatchObject({
      code: "E_PRECONDITION_FAILED",
      details: { currentHash: expect.any(String) },
    });

    const lists = await ipc.reminderListDefs();
    expect(lists[0]?.name).toBe("À faire");
    expect(lists[0]?.updatedAt).toBe(LIST.updatedAt);
  });

  it("refuse un hash fourni pour une liste absente", async () => {
    const ipc = createMockIpc({ moduleData: { lists: [LIST] } });
    await expect(
      ipc.reminderListSave({
        list: { ...LIST, id: "list-disparue" },
        expected: STALE_HASH,
      }),
    ).rejects.toMatchObject({ code: "E_PRECONDITION_FAILED", details: { currentHash: null } });

    // Aucune liste n'a été créée sous cet identifiant.
    expect((await ipc.reminderListDefs()).map((list) => list.id)).toEqual([LIST.id]);
  });

  it("refuse une suppression avec hash périmé et conserve la liste", async () => {
    const ipc = createMockIpc({ moduleData: { lists: [LIST] } });
    await expect(
      ipc.reminderListDelete({ id: LIST.id, expected: STALE_HASH }),
    ).rejects.toMatchObject({
      code: "E_PRECONDITION_FAILED",
      details: { currentHash: expect.any(String) },
    });
    expect((await ipc.reminderListDefs()).map((list) => list.id)).toEqual([LIST.id]);
  });

  it("renvoie E_NOT_FOUND pour une liste absente", async () => {
    const ipc = createMockIpc({ moduleData: { lists: [LIST] } });
    await expect(
      ipc.reminderListDelete({ id: "list-inconnue", expected: STALE_HASH }),
    ).rejects.toMatchObject({ code: "E_NOT_FOUND" });

    // Les autres listes restent intactes.
    expect((await ipc.reminderListDefs()).map((list) => list.id)).toEqual([LIST.id]);
  });
});

describe("mock IPC — précondition de configuration", () => {
  it("refuse un patch avec une révision périmée sans rien écrire", async () => {
    const ipc = createMockIpc();
    await ipc.vaultOpen({ path: "/vaults/a" });
    const first = await ipc.configGet();
    const updated = await ipc.configPatch({
      patch: { openDashboardOnLaunch: true },
      expectedRevision: first.revision,
    });
    expect(updated.config.openDashboardOnLaunch).toBe(true);
    expect(updated.revision).not.toBe(first.revision);

    await expect(
      ipc.configPatch({
        patch: { dayStartHour: 5 },
        expectedRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "E_PRECONDITION_FAILED" });

    const after = await ipc.configGet();
    expect(after.config.dayStartHour).toBe(4);
    expect(after.config.openDashboardOnLaunch).toBe(true);
    expect(after.revision).toBe(updated.revision);
  });

  it("remplace les tableaux en bloc", async () => {
    const ipc = createMockIpc();
    await ipc.vaultOpen({ path: "/vaults/a" });
    const snapshot = await ipc.configGet();
    const patched = await ipc.configPatch({
      patch: { dashboard: { widgets: [] }, views: [] },
      expectedRevision: snapshot.revision,
    });
    expect(patched.config.dashboard.widgets).toEqual([]);
    expect(patched.config.views).toEqual([]);
    expect(patched.config.dashboard.columns).toBe(12);
  });
});

describe("mock IPC — journée logique", () => {
  it("03:59 → journée précédente, 04:00 → nouvelle journée", async () => {
    const clock = fixedClock("2026-10-27T02:59:00.000Z");
    const ipc = createMockIpc({ now: clock.now, timeZone: PARIS });
    await ipc.vaultOpen({ path: "/vaults/a" });

    const before = await ipc.dayStateGet();
    expect(before.logicalDay).toBe("2026-10-26");
    expect(before.started).toBe(false);

    clock.set("2026-10-27T03:00:00.000Z");
    const after = await ipc.dayStateGet();
    expect(after.logicalDay).toBe("2026-10-27");
    expect(after.started).toBe(false);
  });

  it("day_start est idempotent par journée logique", async () => {
    const clock = fixedClock("2026-10-27T02:30:00.000Z");
    const ipc = createMockIpc({ now: clock.now, timeZone: PARIS });
    await ipc.vaultOpen({ path: "/vaults/a" });

    const started = await ipc.dayStart({ at: clock.now().toISOString() });
    expect(started.started).toBe(true);
    expect(started.logicalDay).toBe("2026-10-26");

    const again = await ipc.dayStart({ at: "2026-10-27T02:45:00.000Z" });
    expect(again.started).toBe(true);
    expect(again.lastDayStartedAt).toBe("2026-10-27T02:30:00.000Z");

    const nextDay = await ipc.dayStart({ at: "2026-10-27T03:05:00.000Z" });
    clock.set("2026-10-27T03:05:00.000Z");
    const nextState = await ipc.dayStateGet();
    expect(nextDay.started).toBe(true);
    expect(nextDay.logicalDay).toBe("2026-10-27");
    expect(nextState.lastDayStartedAt).toBe("2026-10-27T03:05:00.000Z");
  });

  it("le démarrage ne fuit pas d'un vault à l'autre", async () => {
    const clock = fixedClock("2026-10-27T02:30:00.000Z");
    const ipc = createMockIpc({ now: clock.now, timeZone: PARIS });
    await ipc.vaultOpen({ path: "/vaults/a" });
    await ipc.dayStart({ at: clock.now().toISOString() });

    await ipc.vaultOpen({ path: "/vaults/b" });
    const other = await ipc.dayStateGet();
    expect(other.started).toBe(false);
  });

  it("expose la copie de conflit au lieu de la masquer", async () => {
    const ipc = createMockIpc({ conflictCopy: ".dayali/config.conflict-2e3f4a5b-20261026.json" });
    await ipc.vaultOpen({ path: "/vaults/a" });
    const snapshot = await ipc.configGet();
    expect(snapshot.conflictCopy).toBe(".dayali/config.conflict-2e3f4a5b-20261026.json");
  });
});

describe("mock IPC — reminderReport, actions et réconciliation", () => {
  const REMINDER = {
    schemaVersion: 1,
    id: "0199a1b2-0000-7000-8000-000000000101",
    listId: "list-todo",
    title: "Rappel test report",
    notes: null,
    status: "open" as const,
    dueDate: "2026-10-26",
    dueTime: null,
    dueTimeZone: null,
    projectId: null,
    completedAt: null,
    recurrence: null,
    sortKey: null,
    abandonedAt: null,
    createdAt: "2026-10-20T07:10:00.000Z",
    updatedAt: "2026-10-20T07:10:00.000Z",
    machineId: MOCK_MACHINE_ID,
  };

  it("exécute toutes les actions (tomorrow, replan, abandon, restore) avec expected, newDueDate, sourceDay, logicalDay", async () => {
    const ipc = createMockIpc({ moduleData: { reminders: [REMINDER] } });
    await ipc.vaultOpen({ path: "/vaults/a" });
    const ref1 = await ipc.reminderFileRef({ id: REMINDER.id });

    // 1. tomorrow
    const r1 = await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "tomorrow",
      newDueDate: "2026-10-27",
      expected: ref1.hash,
      sourceDay: "2026-10-26",
      logicalDay: "2026-10-27",
    });
    expect(r1.dueDate).toBe("2026-10-27");

    const ref2 = await ipc.reminderFileRef({ id: REMINDER.id });
    // 2. replan
    const r2 = await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "replan",
      newDueDate: "2026-10-30",
      expected: ref2.hash,
      sourceDay: "2026-10-27",
      logicalDay: "2026-10-28",
    });
    expect(r2.dueDate).toBe("2026-10-30");

    const ref3 = await ipc.reminderFileRef({ id: REMINDER.id });
    // 3. abandon
    const r3 = await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "abandon",
      expected: ref3.hash,
      sourceDay: "2026-10-28",
      logicalDay: "2026-10-29",
    });
    expect(r3.status).toBe("abandoned");
    expect(r3.abandonedAt).not.toBeNull();

    const ref4 = await ipc.reminderFileRef({ id: REMINDER.id });
    // 4. restore
    const r4 = await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "restore",
      expected: ref4.hash,
      sourceDay: "2026-10-29",
      logicalDay: "2026-10-30",
    });
    expect(r4.status).toBe("open");
    expect(r4.abandonedAt).toBeNull();
  });

  it("refuse un rapport avec un hash expected incorrect (E_PRECONDITION_FAILED)", async () => {
    const ipc = createMockIpc({ moduleData: { reminders: [REMINDER] } });
    await ipc.vaultOpen({ path: "/vaults/a" });

    await expect(
      ipc.reminderReport({
        reminderId: REMINDER.id,
        action: "abandon",
        expected: STALE_HASH,
        sourceDay: "2026-10-26",
        logicalDay: "2026-10-27",
      }),
    ).rejects.toMatchObject({ code: "E_PRECONDITION_FAILED" });
  });

  it("est idempotent pour une même action sur la même journée logique", async () => {
    const ipc = createMockIpc({ moduleData: { reminders: [REMINDER] } });
    await ipc.vaultOpen({ path: "/vaults/a" });
    const ref1 = await ipc.reminderFileRef({ id: REMINDER.id });

    await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "abandon",
      expected: ref1.hash,
      sourceDay: "2026-10-26",
      logicalDay: "2026-10-27",
    });

    const ref2 = await ipc.reminderFileRef({ id: REMINDER.id });
    const replayed = await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "abandon",
      expected: ref2.hash,
      sourceDay: "2026-10-26",
      logicalDay: "2026-10-27",
    });
    expect(replayed.status).toBe("abandoned");
  });

  it("persiste et réconcilie l'historique lors d'un restart simulé", async () => {
    const ipc = createMockIpc({ moduleData: { reminders: [REMINDER] } });
    await ipc.vaultOpen({ path: "/vaults/a" });
    const ref1 = await ipc.reminderFileRef({ id: REMINDER.id });

    await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "tomorrow",
      newDueDate: "2026-10-27",
      expected: ref1.hash,
      sourceDay: "2026-10-26",
      logicalDay: "2026-10-27",
    });

    // Simulate restart (reopen vault)
    await ipc.vaultOpen({ path: "/vaults/a" });

    // Verify idempotence after restart
    const ref2 = await ipc.reminderFileRef({ id: REMINDER.id });
    const res = await ipc.reminderReport({
      reminderId: REMINDER.id,
      action: "tomorrow",
      newDueDate: "2026-10-27",
      expected: ref2.hash,
      sourceDay: "2026-10-26",
      logicalDay: "2026-10-27",
    });
    expect(res.dueDate).toBe("2026-10-27");
  });
});
