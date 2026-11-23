import { useCallback } from "react";
import { useNavigate } from "react-router";
import { AppShell } from "../components/layout/AppShell";
import { StatusBanners } from "../components/ui/StatusBanners";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import {
  setFollowSystemAccent,
  useFollowSystemAccent,
  useSystemAccentColor,
} from "../lib/system-accent";
import { DEFAULT_ACCENT, type ThemeChoice } from "../lib/theme";
import { resolveTimeZone, systemTimeZone } from "../lib/time";
import { useAppStore } from "../stores/app.store";
import { useUpdaterStore } from "../stores/updater.store";

/** Route Réglages : préférences de l'application, gestion du vault et crédits. */
export function SettingsRoute() {
  const navigate = useNavigate();
  const vault = useAppStore((state) => state.vault);
  const config = useAppStore((state) => state.config);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const conflictCopy = useAppStore((state) => state.configConflictCopy);
  const closeVault = useAppStore((state) => state.closeVault);
  const reloadConfig = useAppStore((state) => state.reloadConfig);
  const setOpenDashboardOnLaunch = useAppStore((state) => state.setOpenDashboardOnLaunch);
  const patchConfig = useAppStore((state) => state.patchConfig);
  const followSystemAccent = useFollowSystemAccent();
  const systemAccentColor = useSystemAccentColor();
  const dismissError = useAppStore((state) => state.dismissError);
  const installedVersion = useUpdaterStore((state) => state.currentVersion);

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

  if (!vault || !config) {
    return (
      <main>
        <p role="status">Chargement des réglages…</p>
      </main>
    );
  }

  return (
    <AppShell
      vaultName={vault.name}
      banners={banners}
      onOpenVaultChooser={() => void openVaultChooser()}
    >
      <SettingsScreen
        vaultName={vault.name}
        vaultPath={vault.root}
        openDashboardOnLaunch={config.openDashboardOnLaunch}
        theme={config.appearance.theme ?? "auto"}
        accentColor={config.appearance.accentColor ?? DEFAULT_ACCENT}
        followSystemAccent={followSystemAccent}
        systemAccentColor={systemAccentColor}
        busy={busy}
        onOpenDashboardOnLaunchChange={(val) => void setOpenDashboardOnLaunch(val)}
        onThemeChange={(theme: ThemeChoice) => void patchConfig({ appearance: { theme } })}
        onAccentColorChange={(accentColor) => void patchConfig({ appearance: { accentColor } })}
        onFollowSystemAccentChange={setFollowSystemAccent}
        onOpenVaultChooser={() => void openVaultChooser()}
        version={installedVersion ?? "inconnue"}
      />
    </AppShell>
  );
}
