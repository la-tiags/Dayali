import { describe, expect, it, vi } from "vitest";
import { tauriIpc } from "./tauri";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("tauri IPC module reads", () => {
  it("maps calendarList to calendar_list and preserves the envelope", async () => {
    invoke.mockResolvedValue({ items: [], warnings: ["fichier ignoré"] });
    const result = await tauriIpc.calendarList({ from: "2026-11-12", to: "2026-11-12" });
    expect(invoke).toHaveBeenCalledWith("calendar_list", { from: "2026-11-12", to: "2026-11-12" });
    expect(result).toEqual({ items: [], warnings: ["fichier ignoré"] });
  });

  it("maps reminderList filter under the filter argument", async () => {
    invoke.mockResolvedValue([]);
    await tauriIpc.reminderList({ statuses: ["open"], dueWithinDays: 0 });
    expect(invoke).toHaveBeenCalledWith("reminder_list", {
      filter: { statuses: ["open"], dueWithinDays: 0 },
    });
  });

  it("maps reminderReport to reminder_report with exact camelCase parameters for all actions", async () => {
    invoke.mockResolvedValue({ id: "r1", status: "open" });
    const actions = ["tomorrow", "replan", "abandon", "restore"] as const;
    for (const action of actions) {
      await tauriIpc.reminderReport({
        reminderId: "r1",
        action,
        ...(action === "replan" ? { newDueDate: "2026-10-30" } : {}),
        expected: "a".repeat(64),
        sourceDay: "2026-10-27",
        logicalDay: "2026-10-28",
      });
      expect(invoke).toHaveBeenCalledWith("reminder_report", {
        reminderId: "r1",
        action,
        ...(action === "replan" ? { newDueDate: "2026-10-30" } : {}),
        expected: "a".repeat(64),
        sourceDay: "2026-10-27",
        logicalDay: "2026-10-28",
      });
    }
  });
});
