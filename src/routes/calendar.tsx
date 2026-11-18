import { useCallback } from "react";
import { useNavigate } from "react-router";
import { AppShell } from "../components/layout/AppShell";
import { StatusBanners } from "../components/ui/StatusBanners";
import { CalendarScreen } from "../features/calendar/CalendarScreen";
import { resolveTimeZone, systemTimeZone } from "../lib/time";
import { useAppStore } from "../stores/app.store";

/** Route Agenda : coquille du vault + état global + écran branché sur le store. */
export function CalendarRoute() {
  const navigate = useNavigate();
  const vault = useAppStore((state) => state.vault);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const conflictCopy = useAppStore((state) => state.configConflictCopy);
  const closeVault = useAppStore((state) => state.closeVault);
  const reloadConfig = useAppStore((state) => state.reloadConfig);
  const dismissError = useAppStore((state) => state.dismissError);

  const resolvedZone = resolveTimeZone(systemTimeZone());

  const openVaultChooser = useCallback(async () => {
    await closeVault();
    navigate("/setup");
  }, [closeVault, navigate]);

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

  if (!vault) {
    return (
      <main>
        <p role="status">Chargement de l'agenda…</p>
      </main>
    );
  }

  return (
    <AppShell
      vaultName={vault.name}
      banners={banners}
      onOpenVaultChooser={() => void openVaultChooser()}
    >
      <CalendarScreen />
    </AppShell>
  );
}
