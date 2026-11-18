import { useCallback, useEffect, useRef } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { photoOfTheDay } from "../assets/home/photos";
import { StatusBanners } from "../components/ui/StatusBanners";
import { TodayScreen } from "../features/today/TodayScreen";
import { dayOfYear, formatLocalDate, isDayStarted, logicalDay } from "../lib/day";
import { filterForMaJournee } from "../lib/reminders";
import { resolveTimeZone, systemTimeZone } from "../lib/time";
import { useClock } from "../lib/useClock";
import { useAppStore } from "../stores/app.store";

/**
 * Route d'accueil (SPEC §6) : écran plein cadre, sans coquille ni navigation.
 * Les rappels ne sont chargés qu'après le passage en aperçu du jour.
 */
export function TodayRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const now = useClock(1000);
  const vault = useAppStore((state) => state.vault);
  const config = useAppStore((state) => state.config);
  const dayState = useAppStore((state) => state.dayState);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const conflictCopy = useAppStore((state) => state.configConflictCopy);
  const reminders = useAppStore((state) => state.reminders);
  const agenda = useAppStore((state) => state.agenda);
  const startDay = useAppStore((state) => state.startDay);
  const loadReminders = useAppStore((state) => state.loadReminders);
  const loadAgenda = useAppStore((state) => state.loadAgenda);
  const markLateNightShown = useAppStore((state) => state.markLateNightShown);
  const reloadConfig = useAppStore((state) => state.reloadConfig);
  const dismissError = useAppStore((state) => state.dismissError);

  const resolvedZone = resolveTimeZone(systemTimeZone());
  const timeZone = resolvedZone.timeZone;
  const logicalDate = config && dayState ? logicalDay(now, config.dayStartHour, timeZone) : null;
  const civilDate = formatLocalDate(now, timeZone);
  const startedToday =
    config && dayState ? isDayStarted(dayState, now, config.dayStartHour, timeZone) : false;

  const goDashboard = useCallback(() => {
    navigate("/dashboard");
  }, [navigate]);

  const reviewHomeRequested =
    (location.state as { reviewHome?: boolean } | null)?.reviewHome === true;
  /**
   * « Revoir l'accueil » est une action ponctuelle, jamais un état persistant :
   * le marqueur de navigation est retiré dès l'arrivée pour qu'un rechargement
   * ou une relance applique à nouveau la règle de lancement (SPEC §6).
   */
  const reviewHomeRef = useRef(reviewHomeRequested);
  useEffect(() => {
    if (!reviewHomeRequested) return;
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, navigate, reviewHomeRequested]);

  /** Journée déjà démarrée au premier rendu : un rechargement doit ouvrir le dashboard. */
  const initiallyStartedRef = useRef<boolean | null>(null);
  if (config && dayState && initiallyStartedRef.current === null) {
    initiallyStartedRef.current = startedToday;
  }

  /** Ne jamais redémarrer une journée déjà démarrée (SPEC §6). */
  const handleStartDay = useCallback(async () => {
    if (startedToday) return true;
    return startDay();
  }, [startDay, startedToday]);

  const handleEnterPreview = useCallback(() => {
    void loadReminders(filterForMaJournee());
    if (logicalDate) void loadAgenda({ from: logicalDate, to: logicalDate });
  }, [loadAgenda, loadReminders, logicalDate]);

  const handleRetryReminders = useCallback(() => {
    void loadReminders(filterForMaJournee());
  }, [loadReminders]);

  const handleRetryAgenda = useCallback(() => {
    if (logicalDate) void loadAgenda({ from: logicalDate, to: logicalDate });
  }, [loadAgenda, logicalDate]);

  /**
   * Journée déjà démarrée au montage (ex. « Voir ma journée ») : l'agenda du
   * jour est chargé sans attendre une seconde action, comme les rappels.
   */
  useEffect(() => {
    if (initiallyStartedRef.current !== true) return;
    if (!logicalDate) return;
    void loadAgenda({ from: logicalDate, to: logicalDate });
  }, [loadAgenda, logicalDate]);

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

  if (!vault) return <Navigate to="/setup" replace />;

  if (!config || !dayState || !logicalDate) {
    return (
      <main>
        <p role="status">Chargement de l'accueil…</p>
      </main>
    );
  }

  if (initiallyStartedRef.current === true && !reviewHomeRef.current) {
    return <Navigate to="/dashboard" replace />;
  }

  // Réglage « ouvrir directement le dashboard » : valable aussi quand la
  // fenêtre arrive directement sur `/today` (rechargement, lien direct), pas
  // seulement via la route `/` (SPEC §6).
  if (config.openDashboardOnLaunch && !reviewHomeRef.current) {
    return <Navigate to="/dashboard" replace />;
  }

  const homeImageConfig = config.appearance.homeImage;
  const daySeed = dayOfYear(now, timeZone);
  const bundledPhoto = photoOfTheDay(daySeed);

  let resolvedPhoto = {
    src: bundledPhoto.src,
    credit: bundledPhoto.credit,
    license: bundledPhoto.license,
    source: bundledPhoto.source,
    licenseUrl: bundledPhoto.licenseUrl,
  };

  if (homeImageConfig?.mode === "unsplash" && homeImageConfig.unsplashQuery) {
    resolvedPhoto = {
      src: `https://images.unsplash.com/photo-${homeImageConfig.unsplashQuery}?auto=format&fit=crop&w=2400&q=80`,
      credit: "Unsplash",
      license: "Unsplash License",
      source: "https://unsplash.com",
      licenseUrl: "https://unsplash.com/license",
    };
  }

  return (
    <TodayScreen
      now={now}
      timeZone={timeZone}
      locale={config.locale}
      civilDate={civilDate}
      logicalDate={logicalDate}
      greetingVariants={config.appearance.greeting.variants}
      greetingSeed={daySeed}
      startedToday={startedToday}
      lastDayStartedAt={dayState.lastDayStartedAt}
      busy={busy}
      onStartDay={handleStartDay}
      onEnterPreview={handleEnterPreview}
      onRetryReminders={handleRetryReminders}
      reminders={reminders.items}
      remindersStatus={reminders.status}
      remindersError={reminders.error}
      agenda={agenda.items}
      agendaStatus={agenda.status}
      agendaError={agenda.error}
      agendaWarnings={agenda.warnings}
      onRetryAgenda={handleRetryAgenda}
      carryOvers={dayState.carryOverCandidates}
      carryOverWarnings={dayState.carryOverWarnings}
      onOpenDashboard={goDashboard}
      banners={banners}
      lateNightEnabled={config.notifications?.lateNight?.enabled ?? true}
      lateNightAfterHour={config.notifications?.lateNight?.afterHour ?? 23}
      lateNightShownFor={dayState.lateNightShownFor}
      onMarkLateNightShown={() => void markLateNightShown()}
      onProposeEndOfDay={goDashboard}
      photo={resolvedPhoto}
    />
  );
}
