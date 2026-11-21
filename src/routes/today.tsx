import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { photoOfTheDay } from "../assets/home/photos";
import { StatusBanners } from "../components/ui/StatusBanners";
import type { CarryOverDecision } from "../features/today/CarryOverActions";
import { TodayScreen } from "../features/today/TodayScreen";
import { addDays } from "../lib/agenda";
import type { Reminder } from "../lib/contracts/types";
import { dayOfYear, formatLocalDate, isDayStarted, logicalDay } from "../lib/day";
import {
  clearCachedHomePhoto,
  type HomePhoto,
  loadDailyHomePhoto,
  preloadImage,
  readCachedHomePhoto,
} from "../lib/home-photos";
import { getIpc } from "../lib/ipc";
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
  const refreshDayState = useAppStore((state) => state.refreshDayState);
  const markLateNightShown = useAppStore((state) => state.markLateNightShown);
  const reloadConfig = useAppStore((state) => state.reloadConfig);
  const dismissError = useAppStore((state) => state.dismissError);

  const resolvedZone = resolveTimeZone(systemTimeZone());
  const timeZone = resolvedZone.timeZone;
  const logicalDate = config && dayState ? logicalDay(now, config.dayStartHour, timeZone) : null;
  const civilDate = formatLocalDate(now, timeZone);
  const startedToday =
    config && dayState ? isDayStarted(dayState, now, config.dayStartHour, timeZone) : false;

  const homeImageMode = config?.appearance.homeImage?.mode ?? "unsplash";
  const homeImageQuery = config?.appearance.homeImage?.unsplashQuery ?? null;
  const [onlinePhoto, setOnlinePhoto] = useState<HomePhoto | null>(() =>
    logicalDate ? readCachedHomePhoto(logicalDate) : null,
  );

  /**
   * Photo Unsplash du jour : métadonnées mises en cache par journée logique pour
   * rester stables, jamais d'octets d'image. Hors ligne ou sans clé, on garde la
   * photo Wikimedia embarquée (aucun écran vide).
   */
  useEffect(() => {
    if (homeImageMode !== "unsplash" || !logicalDate) {
      setOnlinePhoto(null);
      return;
    }
    let cancelled = false;
    const cached = readCachedHomePhoto(logicalDate);
    if (cached) {
      setOnlinePhoto(cached);
      void preloadImage(cached.src).then((ok) => {
        if (cancelled) return;
        if (!ok) {
          clearCachedHomePhoto(logicalDate);
          setOnlinePhoto(null);
        }
      });
      return () => {
        cancelled = true;
      };
    }
    setOnlinePhoto(null);
    void loadDailyHomePhoto({ logicalDate, query: homeImageQuery }).then((photo) => {
      if (!photo || cancelled) return;
      void preloadImage(photo.src).then((ok) => {
        if (ok && !cancelled) setOnlinePhoto(photo);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [homeImageMode, homeImageQuery, logicalDate]);

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

  /**
   * Reste d'une journée non fermée : même décision que l'écran de fin
   * (`reminderReport`), avec la veille comme `sourceDay`. L'état de journée et
   * les rappels du jour sont relus ensuite pour que la liste reste exacte.
   */
  const handleResolveCarryOver = useCallback(
    async (reminder: Reminder, decision: CarryOverDecision) => {
      if (!logicalDate) return;
      const ref = await getIpc().reminderFileRef({ id: reminder.id });
      await getIpc().reminderReport({
        reminderId: reminder.id,
        action: decision.action,
        ...(decision.action === "replan" ? { newDueDate: decision.newDueDate } : {}),
        expected: ref.hash,
        sourceDay: addDays(logicalDate, -1),
        logicalDay: logicalDate,
      });
      await refreshDayState();
      await loadReminders(filterForMaJournee());
    },
    [loadReminders, logicalDate, refreshDayState],
  );

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

  const daySeed = dayOfYear(now, timeZone);
  const bundledPhoto = photoOfTheDay(daySeed);

  const resolvedPhoto = onlinePhoto
    ? {
        src: onlinePhoto.src,
        credit: onlinePhoto.credit,
        license: onlinePhoto.license,
        source: onlinePhoto.source,
        licenseUrl: onlinePhoto.licenseUrl,
        provider: "unsplash" as const,
      }
    : {
        src: bundledPhoto.src,
        credit: bundledPhoto.credit,
        license: bundledPhoto.license,
        source: bundledPhoto.source,
        licenseUrl: bundledPhoto.licenseUrl,
      };

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
      onResolveCarryOver={handleResolveCarryOver}
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
