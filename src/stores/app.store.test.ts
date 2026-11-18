import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_DEFAULT_CONFIG } from "../lib/contracts/defaults";
import type { Reminder, ReminderList, RemindersFilter } from "../lib/contracts/types";
import { configureIpc, getIpc } from "../lib/ipc";
import type { IpcApi } from "../lib/ipc/api";
import { IpcError } from "../lib/ipc/errors";
import { createMockIpc, MOCK_MACHINE_ID } from "../lib/ipc/mock";
import { filterForMaJournee } from "../lib/reminders";
import { resetAppStore, useAppStore } from "./app.store";

const PARIS = "Europe/Paris";
const VAULT = "/Users/mock/Documents/Dayali";

/** Mock IPC dont chaque commande peut être observée sans changer le contrat. */
function mockWithSpies(overrides: Partial<IpcApi> = {}): {
  api: IpcApi;
  calls: Map<string, number>;
} {
  const base = createMockIpc({ timeZone: PARIS });
  const calls = new Map<string, number>();
  const count = <K extends keyof IpcApi>(name: K) => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
  };
  const api: IpcApi = {
    vaultOpen: (input) => {
      count("vaultOpen");
      return base.vaultOpen(input);
    },
    vaultClose: () => {
      count("vaultClose");
      return base.vaultClose();
    },
    configGet: () => {
      count("configGet");
      return base.configGet();
    },
    configPatch: (input) => {
      count("configPatch");
      return base.configPatch(input);
    },
    machineLocalGet: () => {
      count("machineLocalGet");
      return base.machineLocalGet();
    },
    dayStateGet: () => {
      count("dayStateGet");
      return base.dayStateGet();
    },
    dayStart: (input) => {
      count("dayStart");
      return base.dayStart(input);
    },
    dayMarkLateNightShown: (input) => {
      count("dayMarkLateNightShown");
      return base.dayMarkLateNightShown(input);
    },
    ...overrides,
  } as IpcApi;
  configureIpc(api);
  return { api, calls };
}

const state = () => useAppStore.getState();

beforeEach(() => {
  resetAppStore();
});

describe("app store — bootstrap", () => {
  it("expose la machine locale et laisse l'écran de choix quand aucun vault n'est connu", async () => {
    mockWithSpies();

    await state().bootstrap();

    expect(state().status).toBe("ready");
    expect(state().vault).toBeNull();
    expect(state().config).toBeNull();
    expect(state().machineLocal?.machineId).toBe(MOCK_MACHINE_ID);
    expect(state().bootError).toBeNull();
  });

  it("ne lit machine.json qu'une fois même si bootstrap est rappelé", async () => {
    const { calls } = mockWithSpies();

    await state().bootstrap();
    await state().bootstrap();

    expect(calls.get("machineLocalGet")).toBe(1);
  });

  it("rouvre le dernier vault et hydrate config, révision et état de journée", async () => {
    mockWithSpies();
    // Le dernier chemin est connu du mock après une ouverture « manuelle ».
    await getIpc().vaultOpen({ path: VAULT });

    await state().bootstrap();

    expect(state().vault?.root).toBe(VAULT);
    expect(state().config?.dayStartHour).toBe(MOCK_DEFAULT_CONFIG.dayStartHour);
    expect(state().configRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(state().dayState?.started).toBe(false);
    expect(state().status).toBe("ready");
    expect(state().busy).toBe(false);
  });

  it("affiche une erreur de lancement quand le dernier vault est inaccessible", async () => {
    const base = createMockIpc({ timeZone: PARIS });
    await base.vaultOpen({ path: VAULT });
    configureIpc({
      ...base,
      vaultOpen: async () => {
        throw new IpcError("E_NOT_FOUND", "Dossier introuvable.");
      },
    });

    await state().bootstrap();

    expect(state().status).toBe("ready");
    expect(state().vault).toBeNull();
    expect(state().bootError).toMatchObject({ code: "E_NOT_FOUND" });
    expect(state().error).toBeNull();
  });

  it("ne bloque pas l'application si machine.json est illisible", async () => {
    configureIpc({
      ...createMockIpc({ timeZone: PARIS }),
      machineLocalGet: async () => {
        throw new IpcError("E_PERMISSION", "Lecture refusée.");
      },
    });

    await state().bootstrap();

    expect(state().status).toBe("ready");
    expect(state().vault).toBeNull();
    expect(state().bootError).toMatchObject({ code: "E_PERMISSION" });
  });
});

describe("app store — ouverture / fermeture de vault", () => {
  it("conserve le vault courant quand une nouvelle ouverture échoue", async () => {
    mockWithSpies();

    expect(await state().openVault(VAULT)).toBe(true);
    configureIpc({
      ...getIpc(),
      vaultOpen: async () => {
        throw new IpcError("E_NOT_FOUND", "Dossier absent.");
      },
    });

    expect(await state().openVault("/vaults/absent")).toBe(false);

    expect(state().vault?.root).toBe(VAULT);
    expect(state().error).toMatchObject({ code: "E_NOT_FOUND" });
    expect(state().busy).toBe(false);
  });

  it("crée un vault via vaultCreate et charge la session comme une ouverture", async () => {
    configureIpc(createMockIpc({ timeZone: PARIS }));

    expect(await state().createVault("/Users/mock/Documents", "Travail")).toBe(true);

    expect(state().vault).toMatchObject({
      root: "/Users/mock/Documents/Travail",
      name: "Travail",
    });
    expect(state().config).not.toBeNull();
    expect(state().dayState).not.toBeNull();
    expect(state().machineLocal?.recentVaults[0]).toBe("/Users/mock/Documents/Travail");
    expect(state().busy).toBe(false);
  });

  it("refuse un nom invalide et un dossier déjà connu sans écraser", async () => {
    configureIpc(createMockIpc({ timeZone: PARIS }));

    expect(await state().createVault("/Users/mock/Documents", "a/b")).toBe(false);
    expect(state().vault).toBeNull();
    expect(state().error).toMatchObject({ code: "E_SCHEMA_INVALID" });

    await state().openVault("/Users/mock/Documents/Travail");
    await state().closeVault();
    expect(await state().createVault("/Users/mock/Documents", "Travail")).toBe(false);
    expect(state().error).toMatchObject({
      code: "E_PRECONDITION_FAILED",
      details: { reason: "not_empty" },
    });
  });

  it("ferme le vault sans perdre la machine locale", async () => {
    mockWithSpies();
    await state().openVault(VAULT);

    await state().closeVault();

    expect(state().vault).toBeNull();
    expect(state().config).toBeNull();
    expect(state().configRevision).toBeNull();
    expect(state().configConflictCopy).toBeNull();
    expect(state().dayState).toBeNull();
    expect(state().machineLocal?.lastVaultPath).toBe(VAULT);
  });

  it("n'écrit jamais de configuration sans vault ouvert", async () => {
    const { calls } = mockWithSpies();

    expect(await state().setOpenDashboardOnLaunch(true)).toBe(false);
    await state().reloadConfig();

    expect(calls.get("configPatch")).toBeUndefined();
    expect(calls.get("configGet")).toBeUndefined();
  });
});

describe("app store — journée", () => {
  it("ne démarre pas la journée sans vault", async () => {
    const { calls } = mockWithSpies();

    expect(await state().startDay(new Date("2026-10-27T06:00:00.000Z"))).toBe(false);

    expect(calls.get("dayStart")).toBeUndefined();
    expect(state().dayState).toBeNull();
  });

  it("enregistre le démarrage et reste idempotent pour la même journée", async () => {
    mockWithSpies();
    await state().openVault(VAULT);
    const at = new Date("2026-10-27T06:00:00.000Z");

    expect(await state().startDay(at)).toBe(true);
    expect(state().dayState?.started).toBe(true);
    expect(state().dayState?.lastDayStartedAt).toBe(at.toISOString());
    expect(state().dayState?.logicalDay).toBe("2026-10-27");

    expect(await state().startDay(new Date("2026-10-27T20:00:00.000Z"))).toBe(true);
    expect(state().dayState?.lastDayStartedAt).toBe(at.toISOString());
    expect(state().busy).toBe(false);
  });

  it("remonte l'échec de day_start sans simuler un démarrage", async () => {
    mockWithSpies();
    await state().openVault(VAULT);
    configureIpc({
      ...getIpc(),
      dayStart: async () => {
        throw new IpcError("E_INTERNAL", "Écriture impossible.");
      },
    });

    expect(await state().startDay(new Date("2026-10-27T06:00:00.000Z"))).toBe(false);

    expect(state().dayState?.started).toBe(false);
    expect(state().error).toMatchObject({ code: "E_INTERNAL" });
    expect(state().busy).toBe(false);
  });
});

describe("app store — précondition de configuration", () => {
  it("applique le réglage avec la révision courante et n'écrit pas deux fois la même valeur", async () => {
    const { calls } = mockWithSpies();
    await state().openVault(VAULT);
    const before = state().configRevision;

    expect(await state().setOpenDashboardOnLaunch(true)).toBe(true);
    expect(state().config?.openDashboardOnLaunch).toBe(true);
    expect(state().configRevision).not.toBe(before);
    expect(calls.get("configPatch")).toBe(1);

    expect(await state().setOpenDashboardOnLaunch(true)).toBe(true);
    expect(calls.get("configPatch")).toBe(1);
  });

  it("refuse une révision périmée sans écraser la configuration locale", async () => {
    mockWithSpies();
    await state().openVault(VAULT);
    const staleRevision = state().configRevision;
    if (!staleRevision) throw new Error("révision absente");

    // Écriture concurrente (autre fenêtre / autre machine) : la révision avance.
    const concurrent = await getIpc().configPatch({
      patch: { locale: "en-GB" },
      expectedRevision: staleRevision,
    });
    expect(concurrent.revision).not.toBe(staleRevision);

    expect(await state().setOpenDashboardOnLaunch(true)).toBe(false);

    expect(state().error).toMatchObject({ code: "E_PRECONDITION_FAILED", retryable: false });
    expect(state().config?.openDashboardOnLaunch).toBe(false);
    expect(state().config?.locale).toBe("fr-FR");
    expect(state().configRevision).toBe(staleRevision);
    expect(state().busy).toBe(false);
  });

  it("recharge explicitement la configuration après un conflit de révision", async () => {
    mockWithSpies();
    await state().openVault(VAULT);
    const staleRevision = state().configRevision;
    if (!staleRevision) throw new Error("révision absente");
    const concurrent = await getIpc().configPatch({
      patch: { locale: "en-GB", dayStartHour: 5 },
      expectedRevision: staleRevision,
    });
    await state().setOpenDashboardOnLaunch(true);

    await state().reloadConfig();

    expect(state().config?.locale).toBe("en-GB");
    expect(state().config?.dayStartHour).toBe(5);
    expect(state().configRevision).toBe(concurrent.revision);
    expect(state().error).toBeNull();
    expect(state().busy).toBe(false);
  });
});

describe("app store — erreurs", () => {
  it("efface une erreur affichable sur demande", async () => {
    mockWithSpies();
    await state().openVault(VAULT);
    configureIpc({
      ...getIpc(),
      configGet: async () => {
        throw new IpcError("E_SCHEMA_INVALID", "config.json invalide.");
      },
    });
    await state().reloadConfig();
    expect(state().error).not.toBeNull();

    state().dismissError();

    expect(state().error).toBeNull();
  });
});

const REMINDER_LIST: ReminderList = {
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

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    schemaVersion: 1,
    id: "reminder-1",
    listId: REMINDER_LIST.id,
    title: "Payer la facture",
    notes: null,
    status: "open",
    dueDate: "2026-10-26",
    dueTime: null,
    dueTimeZone: null,
    projectId: null,
    completedAt: null,
    recurrence: null,
    sortKey: null,
    createdAt: "2026-10-24T08:00:00.000Z",
    updatedAt: "2026-10-24T08:00:00.000Z",
    machineId: MOCK_MACHINE_ID,
    ...overrides,
  };
}

/** IPC rappels espionnable + état de store équivalent à un vault ouvert. */
function mockReminderIpc(items: Reminder[]) {
  const base = createMockIpc({
    timeZone: PARIS,
    now: () => new Date("2026-10-27T09:00:00.000Z"),
    moduleData: { reminders: items, lists: [REMINDER_LIST] },
  });
  const reminderFileRef = vi.fn((input: { id: string }) => base.reminderFileRef(input));
  const reminderDelete = vi.fn((input: { id: string; expected: string }) =>
    base.reminderDelete(input),
  );
  const reminderSave = vi.fn((input: { reminder: Reminder; expected?: string }) =>
    base.reminderSave(input),
  );
  const reminderList = vi.fn((filter?: RemindersFilter) => base.reminderList(filter));
  const reminderListDefs = vi.fn(() => base.reminderListDefs());
  configureIpc({
    ...base,
    reminderFileRef,
    reminderDelete,
    reminderSave,
    reminderList,
    reminderListDefs,
  });
  useAppStore.setState({
    vault: {
      root: VAULT,
      name: "Dayali",
      machineId: MOCK_MACHINE_ID,
      configRevision: "0".repeat(64),
    },
    // `refs` est vide ici : chaque test le remplit via `loadReminders`, comme
    // le fait l'écran au chargement. Aucun hash n'est inventé par le store.
    reminders: { items, lists: [REMINDER_LIST], refs: {}, status: "ready", error: null },
    remindersFilter: filterForMaJournee(),
  });
  return {
    base,
    reminderFileRef,
    reminderDelete,
    reminderSave,
    reminderList,
    reminderListDefs,
  };
}

describe("app store — rappels", () => {
  it("mémorise le hash de chaque rappel chargé", async () => {
    const first = makeReminder();
    const second = makeReminder({ id: "reminder-2", title: "Appeler le dentiste" });
    const { base } = mockReminderIpc([first, second]);

    expect(await state().loadReminders({})).toBe(true);

    const firstRef = await base.reminderFileRef({ id: first.id });
    const secondRef = await base.reminderFileRef({ id: second.id });
    expect(state().reminders.items).toHaveLength(2);
    expect(state().reminders.refs[first.id]).toBe(firstRef.hash);
    expect(state().reminders.refs[second.id]).toBe(secondRef.hash);
  });

  it("détecte une écriture externe et n'écrase pas la version de l'utilisateur", async () => {
    const loaded = makeReminder({ title: "Version chargée" });
    const { base, reminderSave } = mockReminderIpc([loaded]);
    await state().loadReminders({});
    const loadedRef = state().reminders.refs[loaded.id];
    if (!loadedRef) throw new Error("hash chargé absent");

    // Autre machine : écriture réussie avec le hash de la version chargée.
    await base.reminderSave({
      reminder: { ...loaded, title: "Version autre machine" },
      expected: loadedRef,
    });
    const externalRef = await base.reminderFileRef({ id: loaded.id });
    expect(externalRef.hash).not.toBe(loadedRef);

    const userEdit = { ...loaded, title: "Version utilisateur" };
    expect(await state().saveReminder({ reminder: userEdit })).toBe(false);

    // Le store a bien envoyé le hash chargé, pas un hash relu à la volée.
    expect(reminderSave).toHaveBeenCalledWith({ reminder: userEdit, expected: loadedRef });
    expect(state().reminders.status).toBe("error");
    expect(state().reminders.error).toMatchObject({
      code: "E_PRECONDITION_FAILED",
      retryable: false,
    });
    expect(state().reminders.error?.message).toContain("changé entre-temps");
    // L'UI ne prétend ni que sa version est enregistrée, ni que le vault a changé.
    expect(state().reminders.items[0]?.title).toBe("Version chargée");
    expect(state().reminders.items[0]?.title).not.toBe("Version utilisateur");
    const vaultItems = await base.reminderList({});
    expect(vaultItems.find((item) => item.id === loaded.id)?.title).toBe("Version autre machine");
  });

  it("refuse une édition sans hash connu sans appeler reminderSave", async () => {
    const reminder = makeReminder();
    const { reminderFileRef, reminderSave } = mockReminderIpc([reminder]);

    expect(
      await state().saveReminder({ reminder: { ...reminder, title: "Sans précondition" } }),
    ).toBe(false);

    expect(reminderSave).not.toHaveBeenCalled();
    // Jamais de relecture « réparatrice » juste avant l'écriture.
    expect(reminderFileRef).not.toHaveBeenCalled();
    expect(state().reminders.status).toBe("error");
    expect(state().reminders.error).toMatchObject({ code: "E_PRECONDITION_FAILED" });
    expect(state().reminders.error?.message).toContain("recharge les rappels");
    expect(state().reminders.items[0]?.title).toBe("Payer la facture");
  });

  it("supprime avec exactement le hash de la version chargée", async () => {
    const reminder = makeReminder();
    const { reminderDelete } = mockReminderIpc([reminder]);
    await state().loadReminders({});
    const expected = state().reminders.refs[reminder.id];
    if (!expected) throw new Error("hash chargé absent");

    expect(await state().deleteReminder(reminder.id)).toBe(true);

    expect(reminderDelete).toHaveBeenCalledWith({ id: reminder.id, expected });
    expect(reminderDelete.mock.calls[0]?.[0]).not.toHaveProperty("configRevision");
    expect(state().reminders.items).toHaveLength(0);
    expect(state().reminders.refs[reminder.id]).toBeUndefined();
    expect(state().reminders.error).toBeNull();
  });

  it("refuse la suppression sans hash connu sans appeler reminderDelete", async () => {
    const reminder = makeReminder();
    const { reminderDelete, reminderFileRef } = mockReminderIpc([reminder]);

    expect(await state().deleteReminder(reminder.id)).toBe(false);

    expect(reminderDelete).not.toHaveBeenCalled();
    expect(reminderFileRef).not.toHaveBeenCalled();
    expect(state().reminders.error).toMatchObject({ code: "E_PRECONDITION_FAILED" });
    expect(state().reminders.error?.message).toContain("recharge les rappels");
    expect(state().reminders.items).toHaveLength(1);
  });

  it("conserve le rappel et expose l'erreur quand la précondition échoue", async () => {
    const reminder = makeReminder();
    const { reminderDelete } = mockReminderIpc([reminder]);
    await state().loadReminders({});
    reminderDelete.mockRejectedValueOnce(
      new IpcError("E_PRECONDITION_FAILED", "Le fichier a changé entre-temps."),
    );

    expect(await state().deleteReminder(reminder.id)).toBe(false);

    expect(state().reminders.status).toBe("error");
    expect(state().reminders.error).toMatchObject({ code: "E_PRECONDITION_FAILED" });
    expect(state().reminders.items).toHaveLength(1);
    expect(state().reminders.items[0]?.id).toBe(reminder.id);
    expect(state().reminders.refs[reminder.id]).toBeDefined();
  });

  it("stocke le rappel renvoyé par reminderSave, jamais l'objet envoyé", async () => {
    const input = makeReminder({ id: "", title: "Titre local" });
    const server = makeReminder({
      id: "reminder-serveur",
      title: "Titre normalisé par le vault",
      updatedAt: "2026-10-27T10:00:00.000Z",
      machineId: "machine-distante",
    });
    const { reminderFileRef, reminderSave, reminderList } = mockReminderIpc([]);
    const serverRef = {
      relPath: "reminders/reminder-serveur.json",
      hash: "a".repeat(64),
      size: 1,
      mtime: server.updatedAt,
    };
    reminderSave.mockResolvedValueOnce(server);
    reminderFileRef.mockResolvedValueOnce(serverRef);
    // Le vault contient bien la version renvoyée par l'écriture : la relecture
    // post-écriture peut donc appairer ce contenu et le hash.
    reminderList.mockResolvedValueOnce([server]);

    expect(await state().saveReminder({ reminder: input })).toBe(true);

    expect(reminderSave).toHaveBeenCalledWith({ reminder: input });
    expect(state().reminders.items).toHaveLength(1);
    expect(state().reminders.items[0]).toEqual(server);
    expect(state().reminders.items[0]?.title).toBe("Titre normalisé par le vault");
    expect(state().reminders.refs[server.id]).toBe(serverRef.hash);
    expect(state().reminders.status).toBe("ready");
  });

  it("envoie la précondition chargée à reminderSave et mémorise la nouvelle version", async () => {
    const reminder = makeReminder();
    const { reminderSave } = mockReminderIpc([reminder]);
    await state().loadReminders({});
    const expected = state().reminders.refs[reminder.id];
    if (!expected) throw new Error("hash chargé absent");
    const edited = {
      ...reminder,
      status: "done" as const,
      completedAt: "2026-10-27T10:00:00.000Z",
    };

    expect(await state().saveReminder({ reminder: edited })).toBe(true);

    expect(reminderSave).toHaveBeenCalledWith({ reminder: edited, expected });
    expect(state().reminders.items).toHaveLength(1);
    expect(state().reminders.items[0]?.status).toBe("done");
    // La nouvelle version écrite est mémorisée après le succès.
    expect(state().reminders.refs[reminder.id]).toMatch(/^[0-9a-f]{64}$/);
    expect(state().reminders.refs[reminder.id]).not.toBe(expected);
  });

  it("crée un rappel avec id vide sans précondition et mémorise le hash renvoyé", async () => {
    const draft = makeReminder({ id: "" });
    const { reminderSave } = mockReminderIpc([]);

    expect(await state().saveReminder({ reminder: draft })).toBe(true);

    expect(reminderSave).toHaveBeenCalledWith({ reminder: draft });
    const saved = state().reminders.items[0];
    if (!saved) throw new Error("rappel créé absent");
    expect(saved.id).not.toBe("");
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(state().reminders.refs[saved.id]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("garde un succès si le hash n'est pas relisible, sans hash périmé", async () => {
    const draft = makeReminder({ id: "" });
    const { reminderFileRef } = mockReminderIpc([]);
    // Toutes les relectures échouent : l'écriture a bien eu lieu, elle ne doit
    // pas être rapportée comme un échec (sinon l'utilisateur recrée et duplique).
    reminderFileRef.mockRejectedValue(new IpcError("E_INTERNAL", "Hash illisible."));

    expect(await state().saveReminder({ reminder: draft })).toBe(true);

    expect(state().reminders.items).toHaveLength(1);
    expect(state().reminders.status).toBe("ready");
    expect(state().reminders.error).toMatchObject({ code: "E_INTERNAL" });
    expect(state().reminders.error?.message).toContain("Rappel enregistré");
    const saved = state().reminders.items[0];
    if (!saved) throw new Error("rappel écrit absent");
    // Aucun hash périmé n'est conservé : l'édition suivante exigera un rechargement.
    expect(state().reminders.refs[saved.id]).toBeUndefined();
  });

  it("n'adopte pas un hash plus récent que le contenu affiché", async () => {
    const loaded = makeReminder({ title: "Version affichée" });
    const { base, reminderFileRef, reminderSave, reminderList } = mockReminderIpc([loaded]);
    await state().loadReminders({});
    const edit = { ...loaded, title: "Version utilisateur" };
    let external: Reminder | null = null;

    // Notre écriture S a réussi, mais avant que la relecture du hash ne
    // réponde, une autre machine écrit E avec le hash de S. La relecture
    // renvoie donc le hash de E, jamais celui de S.
    reminderFileRef.mockImplementationOnce(async (input) => {
      const current = await base.reminderFileRef(input);
      external = { ...loaded, title: "Version autre machine" };
      await base.reminderSave({ reminder: external, expected: current.hash });
      return base.reminderFileRef(input);
    });

    expect(await state().saveReminder({ reminder: edit })).toBe(true);

    expect(external).not.toBeNull();
    expect(reminderSave).toHaveBeenCalledTimes(1);
    // Le contenu affiché reste celui de notre écriture réussie (S).
    expect(state().reminders.items[0]?.title).toBe("Version utilisateur");
    // Aucun hash n'est mémorisé : celui relu décrit E, pas S.
    expect(state().reminders.refs[loaded.id]).toBeUndefined();
    expect(state().reminders.status).toBe("ready");
    expect(state().reminders.error).toMatchObject({
      code: "E_PRECONDITION_FAILED",
      retryable: false,
    });
    expect(state().reminders.error?.message).toContain("une autre version est apparue");

    // Édition suivante : refusée faute de hash, sans toucher au vault (donc
    // sans écraser E ni recréer un doublon).
    expect(await state().saveReminder({ reminder: { ...loaded, title: "Deuxième édition" } })).toBe(
      false,
    );
    expect(reminderSave).toHaveBeenCalledTimes(1);
    expect(state().reminders.refs[loaded.id]).toBeUndefined();
    expect(reminderList).toHaveBeenCalled();
    const vaultItems = await base.reminderList({});
    expect(vaultItems.find((item) => item.id === loaded.id)?.title).toBe("Version autre machine");
  });

  it("relance la lecture si la liste change pendant le chargement des hashes", async () => {
    const reminder = makeReminder({ title: "Version stable" });
    const { base, reminderList, reminderFileRef } = mockReminderIpc([reminder]);
    const transientHash = "f".repeat(64);
    // Première lecture : contenu transitoire appairé à un hash transitoire.
    reminderList.mockResolvedValueOnce([{ ...reminder, title: "Version transitoire" }]);
    reminderFileRef.mockResolvedValueOnce({
      relPath: `reminders/${reminder.id}.json`,
      hash: transientHash,
      size: 1,
      mtime: reminder.updatedAt,
    });

    expect(await state().loadReminders({})).toBe(true);

    expect(reminderFileRef).toHaveBeenCalledTimes(2);
    // Le couple conservé est celui de la lecture stable : hash stable, pas le
    // hash transitoire de la première tentative.
    const stableRef = await base.reminderFileRef({ id: reminder.id });
    expect(state().reminders.items[0]?.title).toBe("Version stable");
    expect(state().reminders.refs[reminder.id]).toBe(stableRef.hash);
    expect(state().reminders.refs[reminder.id]).not.toBe(transientHash);
  });

  it("échoue après trois lectures instables sans publier de hash", async () => {
    const reminder = makeReminder();
    const { reminderList } = mockReminderIpc([reminder]);
    let tick = 0;
    reminderList.mockImplementation(async () => {
      tick += 1;
      return [{ ...reminder, title: `Version ${tick}` }];
    });

    expect(await state().loadReminders({})).toBe(false);

    expect(reminderList).toHaveBeenCalledTimes(6);
    expect(state().reminders.status).toBe("error");
    expect(state().reminders.items).toEqual([]);
    expect(state().reminders.lists).toEqual([]);
    expect(state().reminders.refs).toEqual({});
    expect(state().reminders.error).toMatchObject({
      code: "E_PRECONDITION_FAILED",
      retryable: true,
    });
  });

  it("relit les définitions de listes et ne publie que la version stable", async () => {
    const reminder = makeReminder();
    const { reminderListDefs } = mockReminderIpc([reminder]);
    reminderListDefs.mockResolvedValueOnce([{ ...REMINDER_LIST, name: "Transitoire" }]);

    expect(await state().loadReminders({})).toBe(true);

    // La définition transitoire n'est jamais publiée : la seconde lecture,
    // stable, fait foi.
    expect(state().reminders.lists).toHaveLength(1);
    expect(state().reminders.lists[0]?.name).toBe("À faire");
    expect(reminderListDefs.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
