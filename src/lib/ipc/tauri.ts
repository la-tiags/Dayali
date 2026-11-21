import { invoke } from "@tauri-apps/api/core";
import type {
  CalendarListResult,
  ConfigSnapshot,
  DayState,
  FeedStatus,
  FileRef,
  LocalCalendarEvent,
  MachineLocal,
  Reminder,
  ReminderList,
  VaultInfo,
} from "../contracts/types";
import type {
  CalendarDeleteInput,
  CalendarFileRefInput,
  CalendarImportFeedInput,
  CalendarListInput,
  CalendarSaveInput,
  ConfigPatchInput,
  HomePhoto,
  IpcApi,
  ReminderDeleteInput,
  ReminderFileRefInput,
  ReminderListDeleteInput,
  ReminderListSaveInput,
  ReminderReportInput,
  ReminderSaveInput,
  VaultCreateInput,
  VaultOpenInput,
} from "./api";

/**
 * Implémentation Tauri : un simple adaptateur typé au-dessus de `invoke`.
 * Aucune logique métier ici — les préconditions, le hash et le disque sont en Rust.
 */
export const tauriIpc: IpcApi = {
  vaultOpen: (input: VaultOpenInput) => invoke<VaultInfo>("vault_open", { path: input.path }),

  vaultCreate: (input: VaultCreateInput) =>
    invoke<VaultInfo>("vault_create", { parentPath: input.parentPath, name: input.name }),

  vaultClose: () => invoke<void>("vault_close"),

  configGet: () => invoke<ConfigSnapshot>("config_get"),

  configPatch: (input: ConfigPatchInput) =>
    invoke<ConfigSnapshot>("config_patch", {
      patch: input.patch,
      expectedRevision: input.expectedRevision,
    }),

  machineLocalGet: () => invoke<MachineLocal>("machine_local_get"),

  dayStateGet: () => invoke<DayState>("day_state_get"),

  dayStart: (input) => invoke<DayState>("day_start", { at: input.at }),

  dayMarkLateNightShown: (input) => invoke<DayState>("day_mark_late_night_shown", { at: input.at }),

  calendarList: (input: CalendarListInput) =>
    invoke<CalendarListResult>("calendar_list", { from: input.from, to: input.to }),

  calendarFileRef: (input: CalendarFileRefInput) =>
    invoke<FileRef>("calendar_file_ref", { id: input.id }),

  calendarSave: (input: CalendarSaveInput) =>
    invoke<LocalCalendarEvent>("calendar_save", { event: input.event, expected: input.expected }),

  calendarDelete: (input: CalendarDeleteInput) =>
    invoke<void>("calendar_delete", { eventId: input.eventId, expected: input.expected }),

  calendarImportFeed: (input: CalendarImportFeedInput) =>
    invoke<FeedStatus>("calendar_import_feed", { feedId: input.feedId, url: input.url }),

  reminderList: (input) => invoke<Reminder[]>("reminder_list", input ? { filter: input } : {}),

  reminderListDefs: () => invoke<ReminderList[]>("reminder_list_defs"),

  reminderFileRef: (input: ReminderFileRefInput) =>
    invoke<FileRef>("reminder_file_ref", { id: input.id }),

  reminderSave: (input: ReminderSaveInput) =>
    invoke<Reminder>("reminder_save", { reminder: input.reminder, expected: input.expected }),

  reminderDelete: (input: ReminderDeleteInput) =>
    invoke<void>("reminder_delete", { id: input.id, expected: input.expected }),

  reminderListSave: (input: ReminderListSaveInput) =>
    invoke<ReminderList>("reminder_list_save", { list: input.list, expected: input.expected }),

  reminderListDelete: (input: ReminderListDeleteInput) =>
    invoke<void>("reminder_list_delete", { id: input.id, expected: input.expected }),

  reminderReport: (input: ReminderReportInput) =>
    invoke<Reminder>("reminder_report", {
      reminderId: input.reminderId,
      action: input.action,
      newDueDate: input.newDueDate,
      expected: input.expected,
      sourceDay: input.sourceDay,
      logicalDay: input.logicalDay,
    }),

  homePhotoUnsplash: (input) => invoke<HomePhoto | null>("home_photo_unsplash", { input }),
};
