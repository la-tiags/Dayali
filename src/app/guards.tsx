import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { isDayStarted } from "../lib/day";
import { resolveLanding } from "../lib/landing";
import { resolveTimeZone, systemTimeZone } from "../lib/time";
import { useClock } from "../lib/useClock";
import { useAppStore } from "../stores/app.store";

/**
 * Redirection d'entrée : une seule apparition de l'accueil par journée logique
 * et par machine, ou dashboard direct si `openDashboardOnLaunch` (SPEC §6).
 */
export function LandingRedirect() {
  const vault = useAppStore((state) => state.vault);
  const config = useAppStore((state) => state.config);
  const dayState = useAppStore((state) => state.dayState);
  const now = useClock(30_000);

  if (!vault) return <Navigate to="/setup" replace />;
  if (!config || !dayState) return <Navigate to="/today" replace />;

  const { timeZone } = resolveTimeZone(systemTimeZone());
  const startedToday = isDayStarted(dayState, now, config.dayStartHour, timeZone);
  const target = resolveLanding({
    hasVault: true,
    openDashboardOnLaunch: config.openDashboardOnLaunch,
    startedToday,
  });
  return <Navigate to={target} replace />;
}

/** Garde des écrans qui exigent un vault ouvert : jamais d'écran vide trompeur. */
export function RequireVault({ children }: { children: ReactNode }) {
  const vault = useAppStore((state) => state.vault);
  if (!vault) return <Navigate to="/setup" replace />;
  return <>{children}</>;
}
