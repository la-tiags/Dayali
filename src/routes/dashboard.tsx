import { useCallback } from "react";
import { useNavigate } from "react-router";
import { AppShell } from "../components/layout/AppShell";
import { StatusBanners } from "../components/ui/StatusBanners";
import { DashboardScreen } from "../features/dashboard/DashboardScreen";
import type { SavedView, WidgetPlacement } from "../lib/contracts/types";
import { isDayStarted, logicalDay } from "../lib/day";
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
  const closeVault = useAppStore((state) => state.closeVault);
  const reloadConfig = useAppStore((state) => state.reloadConfig);
  const patchConfig = useAppStore((state) => state.patchConfig);
  const setOpenDashboardOnLaunch = useAppStore((state) => state.setOpenDashboardOnLaunch);
  const dismissError = useAppStore((state) => state.dismissError);

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
    async (module: "reminders" | "agenda" = "reminders") => {
      if (!config) return;
      let views: SavedView[] = [...config.views];
      let view = views.find((v) => v.module === module);
      if (!view) {
        const nowIso = new Date().toISOString();
        view = {
          id: crypto.randomUUID(),
          module,
          name: module === "agenda" ? "Agenda" : "Rappels",
          origin: "widget",
          filter:
            module === "agenda" ? { rangeDays: 7, includeAllDay: true } : { statuses: ["open"] },
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        views = [...views, view];
      }
      const widget: WidgetPlacement = {
        id: crypto.randomUUID(),
        module,
        viewId: view.id,
        title: module === "agenda" ? "Agenda" : "Rappels",
        layout: { x: 0, y: 0, w: module === "agenda" ? 6 : 4, h: 4 },
        enabled: true,
      };
      const widgets = [...config.dashboard.widgets, widget];
      await patchConfig({ views, dashboard: { widgets } });
      await reloadConfig();
    },
    [config, patchConfig, reloadConfig],
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
      const widgets = config.dashboard.widgets.map((w) => {
        if (w.id !== id) return w;
        const delta =
          direction === "up"
            ? { x: w.layout.x, y: Math.max(0, w.layout.y - 1) }
            : direction === "down"
              ? { x: w.layout.x, y: w.layout.y + 1 }
              : direction === "left"
                ? { x: Math.max(0, w.layout.x - 1), y: w.layout.y }
                : { x: w.layout.x + 1, y: w.layout.y };
        return { ...w, layout: { ...w.layout, ...delta } };
      });
      await persistWidgets(widgets);
      await reloadConfig();
    },
    [config, persistWidgets, reloadConfig],
  );

  const handleResizeWidget = useCallback(
    async (id: string, w: number, h: number) => {
      if (!config) return;
      const widgets = config.dashboard.widgets.map((widget) =>
        widget.id === id
          ? { ...widget, layout: { ...widget.layout, w: Math.max(2, w), h: Math.max(2, h) } }
          : widget,
      );
      await persistWidgets(widgets);
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
        onResizeWidget={(id, w, h) => void handleResizeWidget(id, w, h)}
      />
    </AppShell>
  );
}
