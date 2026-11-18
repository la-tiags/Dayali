import type { Config } from "./types";

/**
 * Valeurs par défaut de `config.json` **pour le mock navigateur uniquement**.
 * La création réelle du fichier et l'application des défauts du schéma sont la
 * responsabilité de Rust (`vault_open` → `config.json`, docs/PLAN.md §4.1).
 * Ne jamais utiliser ces valeurs comme source de vérité dans l'UI : elles ne
 * servent qu'à faire tourner l'app hors Tauri.
 */
export const MOCK_DEFAULT_CONFIG: Config = {
  schemaVersion: 1,
  dayStartHour: 4,
  openDashboardOnLaunch: false,
  locale: "fr-FR",
  weekStartsOn: 1,
  dashboard: {
    columns: 12,
    rowHeight: 40,
    widgets: [
      {
        id: "0199a1b2-a3b4-7fc5-9a71-8c9d0e1f2a3b",
        module: "reminders",
        viewId: "0199a1b2-8192-7da3-9e5f-6a7b8c9d0e1f",
        title: "Ma journée",
        layout: { x: 0, y: 0, w: 8, h: 6 },
        enabled: true,
      },
      {
        id: "0199a1b2-b4c5-7086-8b82-9d0e1f2a3b4c",
        module: "agenda",
        viewId: "0199a1b2-92a3-7eb4-8f60-7b8c9d0e1f2",
        title: "Agenda du jour",
        layout: { x: 8, y: 0, w: 4, h: 6 },
        enabled: true,
      },
    ],
  },
  views: [
    {
      id: "0199a1b2-8192-7da3-9e5f-6a7b8c9d0e1f",
      module: "reminders",
      name: "Ma journée",
      icon: "sun",
      origin: "user",
      filter: { statuses: ["open"], dueWithinDays: 0 },
      sort: { field: "dueDate", direction: "asc" },
      createdAt: "2026-10-20T07:10:00.000Z",
      updatedAt: "2026-10-26T06:40:00.000Z",
    },
    {
      id: "0199a1b2-92a3-7eb4-8f60-7b8c9d0e1f2",
      module: "agenda",
      name: "Agenda du jour",
      icon: "calendar",
      origin: "widget",
      filter: { rangeDays: 1, includeAllDay: true },
      createdAt: "2026-10-20T07:10:00.000Z",
      updatedAt: "2026-10-20T07:10:00.000Z",
    },
  ],
  quotes: {
    mode: "bundled-only",
    api: { provider: "none" },
    refreshHour: 4,
    includeCustom: true,
    pinnedIds: [],
  },
  notifications: {
    lateNight: { enabled: true, afterHour: 23 },
    dueReminders: { enabled: false },
  },
  appearance: {
    greeting: { variants: true },
    homeImage: { mode: "bundled", showCredit: true, dim: 0.35 },
  },
};
