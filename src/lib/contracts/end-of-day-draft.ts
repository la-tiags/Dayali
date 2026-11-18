import type { ReportAction } from "./end-of-day";
import type { LocalDate, Sha256 } from "./types";

export type EndOfDayDraftAction = ReportAction;

export interface PendingTaskIntent {
  readonly reminderId: string;
  readonly action: EndOfDayDraftAction;
  readonly newDueDate?: LocalDate;
  readonly expectedHash?: Sha256 | null;
}

export interface QuickAddDraftTask {
  readonly tempId: string;
  readonly title: string;
  readonly dueDate: LocalDate;
}

export interface EndOfDayDraftState {
  readonly vaultRoot: string;
  readonly logicalDate: LocalDate;
  readonly intents: Record<string, PendingTaskIntent>;
  readonly quickAddTasks: QuickAddDraftTask[];
  readonly journalNote: string;
  readonly updatedAt: string;
}

export function getStorageKey(vaultRoot: string, logicalDate: LocalDate): string {
  return `dayali:e3-draft:${vaultRoot}:${logicalDate}`;
}

export function loadEndOfDayDraft(
  vaultRoot: string,
  logicalDate: LocalDate,
): EndOfDayDraftState | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(getStorageKey(vaultRoot, logicalDate));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EndOfDayDraftState;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveEndOfDayDraft(state: EndOfDayDraftState): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const key = getStorageKey(state.vaultRoot, state.logicalDate);
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function clearEndOfDayDraft(vaultRoot: string, logicalDate: LocalDate): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const key = getStorageKey(vaultRoot, logicalDate);
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
