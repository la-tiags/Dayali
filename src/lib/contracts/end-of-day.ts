import type { IsoDateTime, LocalDate, Sha256 } from "./types";

/** Actions sérialisées par `reminder_report` (mêmes valeurs que Rust). */
export type ReportAction = "tomorrow" | "replan" | "abandon" | "restore";
export type ReminderHistoryStatus = "pending" | "applied";

/** Entrée append-only de l'état machine, y compris les intentions en attente. */
export interface ReminderHistoryEntry {
  readonly id: string;
  readonly status: ReminderHistoryStatus;
  readonly reminderId: string;
  readonly action: ReportAction;
  readonly sourceDay: LocalDate;
  readonly logicalDay: LocalDate;
  readonly dueDate: LocalDate | null;
  readonly newDueDate: LocalDate | null;
  /** Hash de la version lue avant l'application, absent dans les anciens vaults. */
  readonly expectedHash?: Sha256 | null;
  readonly createdAt: IsoDateTime;
  readonly resolvedAt: IsoDateTime | null;
}

export interface ReminderReportInput {
  readonly reminderId: string;
  readonly action: ReportAction;
  readonly newDueDate?: LocalDate;
  readonly expected: Sha256;
  readonly sourceDay: LocalDate;
  readonly logicalDay: LocalDate;
}
