import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router";
import { AppShell } from "../components/layout/AppShell";
import { StatusBanners } from "../components/ui/StatusBanners";
import { type AddWidgetTarget, DashboardScreen } from "../features/dashboard/DashboardScreen";
import type { ReminderList, SavedView, WidgetPlacement } from "../lib/contracts/types";
import {
  applyMove,
  applyPosition,
  applyResize,
  findFreeSlot,
  healLayout,
} from "../lib/dashboardLayout";
import { isDayStarted, logicalDay } from "../lib/day";
import { getIpc } from "../lib/ipc";
import { resolveTimeZone, systemTimeZone } from "../lib/time";
import { useClock } from "../lib/useClock";
import { useAppStore } from "../stores/app.store";

/** Route du dashboard : édition de la disposition persistée via config_patch. */
export function DashboardRoute() {
  const navigate = useNavigate();
  const now = useClock(30_000);
  const vault = useAppStore((state) => state.vault);
  const config = useAppStore((state) => state.config);
  const dayState = useAppStore((state) => state.dayState);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const conflictCopy = useAppStore((state) => state.configConflictCopy);
  const reminderLists = useAppStore((state) => state.reminders.lists);
  const loadReminders = useAppStore((state) => state.loadReminders);
  const closeVault = useAppStore((state) => state.closeVault);
  const reloadConfig = useAppStore((state) => state.reloadConfig);
  const patchConfig = useAppStore((state) => state.patchConfig);
  const setOpenDashboardOnLaunch = useAppStore((state) => state.setOpenDashboardOnLaunch);
  const dismissError = useAppStore((state) => state.dismissError);

  useEffect(() => {
    void loadReminders();
  }, [loadReminders]);

  const resolvedZone = resolveTimeZone(systemTimeZone());
  const timeZone = resolvedZone.timeZone;
  const logicalDate = config ? logicalDay(now, config.dayStartHour, timeZone) : null;

  const backHome = useCallback(() => {
    // Marqueur ponctuel : l'accueil s'affiche même journée démarrée, mais un
    // rechargement ultérieur réapplique la règle de lancement (SPEC §6).
    navigate("/today", { state: { reviewHome: true } });
  }, [navigate]);

  const openVaultChooser = useCallback(async () => {
    await closeVault();
    navigate("/setup");
  }, [closeVault, navigate]);

  const persistWidgets = useCallback(
    async (widgets: WidgetPlacement[]) => {
      await patchConfig({ dashboard: { widgets } });
    },
    [patchConfig],
  );

  const handleAddWidget = useCallback(
    async (target: "reminders" | "agenda" | AddWidgetTarget = "reminders") => {
      if (!config) return;
      const nowIso = new Date().toISOString();
      let module: "reminders" | "agenda" = "reminders";
      let title = "Rappels";
      let filter: Record<string, unknown> = { statuses: ["open"] };

      if (target === "agenda" || (typeof target === "object" && target.type === "agenda")) {
        module = "agenda";
        title = "Agenda";
        filter = { rangeDays: 7, includeAllDay: true };
      } else if (typeof target === "object" && target.type === "reminders-today") {
        title = "Ma journée";
        filter = { statuses: ["open"], dueWithinDays: 0 };
      } else if (typeof target === "object" && target.type === "reminders-list") {
        title = target.listName;
        filter = { listIds: [target.listId], statuses: ["open"] };
      } else {
        title = "Toutes les tâches";
        filter = { statuses: ["open"] };
      }

      const viewId = crypto.randomUUID();
      const view: SavedView = {
        id: viewId,
        module,
        name: title,
        origin: "widget",
        filter,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const existing = healLayout(config.dashboard.widgets);
      const size = { w: module === "agenda" ? 6 : 4, h: 6 };
      const slot = findFreeSlot(
        existing.map((candidate) => candidate.layout),
        size.w,
        size.h,
      );

      const widget: WidgetPlacement = {
        id: crypto.randomUUID(),
        module,
        viewId,
        title,
        layout: { ...slot, ...size },
        enabled: true,
      };

      const views = [...config.views, view];
      const widgets = [...existing, widget];
      await patchConfig({ views, dashboard: { widgets } });
      await reloadConfig();
    },
    [config, patchConfig, reloadConfig],
  );

  const handleChangeWidgetList = useCallback(
    async (widgetId: string, targetList: string | null) => {
      if (!config) return;
      const widget = config.dashboard.widgets.find((w) => w.id === widgetId);
      if (!widget) return;

      const lists =
        reminderLists.length > 0
          ? reminderLists
          : await getIpc()
              .reminderListDefs()
              .catch(() => [] as ReminderList[]);
      const chosenList = lists.find((l) => l.id === targetList);

      const title =
        targetList === "__my_day__"
          ? "Ma journée"
          : chosenList
            ? chosenList.name
            : "Toutes les tâches";

      const filter =
        targetList === "__my_day__"
          ? { statuses: ["open"], dueWithinDays: 0 }
          : chosenList
            ? { listIds: [chosenList.id], statuses: ["open"] }
            : { statuses: ["open"] };

      const nowIso = new Date().toISOString();
      const newViewId = crypto.randomUUID();
      const newView: SavedView = {
        id: newViewId,
        module: "reminders",
        name: title,
        origin: "widget",
        filter,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      const views = [...config.views, newView];
      const widgets = config.dashboard.widgets.map((w) =>
        w.id === widgetId ? { ...w, viewId: newViewId, title } : w,
      );

      await patchConfig({ views, dashboard: { widgets } });
      await reloadConfig();
    },
    [config, patchConfig, reloadConfig, reminderLists],
  );

  const handleRemoveWidget = useCallback(
    async (id: string) => {
      if (!config) return;
      await persistWidgets(config.dashboard.widgets.filter((w) => w.id !== id));
      await reloadConfig();
    },
    [config, persistWidgets, reloadConfig],
  );

  const handleToggleWidget = useCallback(
    async (id: string) => {
      if (!config) return;
      await persistWidgets(
        config.dashboard.widgets.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)),
      );
      await reloadConfig();
    },
    [config, persistWidgets, reloadConfig],
  );

  const handleMoveWidget = useCallback(
    async (id: string, direction: "up" | "down" | "left" | "right") => {
      if (!config) return;
      await persistWidgets(applyMove(config.dashboard.widgets, id, direction));
      await reloadConfig();
    },
    [config, persistWidgets, reloadConfig],
  );

  const handleResizeWidget = useCallback(
    async (id: string, w: number, h: number) => {
      if (!config) return;
      await persistWidgets(applyResize(config.dashboard.widgets, id, w, h));
      await reloadConfig();
    },
    [config, persistWidgets, reloadConfig],
  );

  const handleDragWidget = useCallback(
    async (id: string, x: number, y: number) => {
      if (!config) return;
      await persistWidgets(applyPosition(config.dashboard.widgets, id, x, y));
      await reloadConfig();
    },
    [config, persistWidgets, reloadConfig],
  );

  const handleOpenDashboardOnLaunchChange = useCallback(
    (value: boolean) => {
      void setOpenDashboardOnLaunch(value);
    },
    [setOpenDashboardOnLaunch],
  );

  const banners = (
    <StatusBanners
      error={error}
      conflictCopy={conflictCopy}
      timeZoneWarning={resolvedZone.warning}
      reloading={busy}
      onReloadConfig={() => void reloadConfig()}
      onDismissError={dismissError}
    />
  );

  if (!vault || !config || !dayState || !logicalDate) {
    return (
      <main>
        <p role="status">Chargement du dashboard…</p>
      </main>
    );
  }

  const started = isDayStarted(dayState, now, config.dayStartHour, timeZone);

  return (
    <AppShell
      vaultName={vault.name}
      banners={banners}
      onOpenVaultChooser={() => void openVaultChooser()}
    >
      <DashboardScreen
        config={config}
        logicalDate={logicalDate}
        started={started}
        onBackHome={backHome}
        onOpenVaultChooser={() => void openVaultChooser()}
        busy={busy}
        onOpenDashboardOnLaunchChange={handleOpenDashboardOnLaunchChange}
        onAddWidget={(module) => void handleAddWidget(module)}
        onRemoveWidget={(id) => void handleRemoveWidget(id)}
        onToggleWidget={(id) => void handleToggleWidget(id)}
        onMoveWidget={(id, dir) => void handleMoveWidget(id, dir)}
        onResizeWidget={(id, w, h) => handleResizeWidget(id, w, h)}
        onDragWidget={(id, x, y) => handleDragWidget(id, x, y)}
        onChangeWidgetList={handleChangeWidgetList}
        reminderLists={reminderLists}
      />
    </AppShell>
  );
}
