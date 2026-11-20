import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import bundledQuotes from "../../assets/quotes-fr.json";
import { Button } from "../../components/ui/Button";
import { SkipLink } from "../../components/ui/SkipLink";
import type { CalendarItem, Reminder } from "../../lib/contracts/types";
import type { DayaliError } from "../../lib/ipc/errors";
import { formatClock, formatLongDate, hourInZone, minuteInZone } from "../../lib/time";
import { DayPreview } from "./DayPreview";
import styles from "./TodayScreen.module.css";

export type TodayPhase = "home" | "preview";

/** Photo approuvée et crédit exact (SPEC §6). Aucune photo par défaut. */
export interface TodayPhoto {
  readonly src: string;
  readonly credit: string;
  readonly license: string;
  /** Page d'origine de la photo, exposée en infobulle du crédit. */
  readonly source?: string;
  /** Texte de la licence, conservé pour vérification (non rendu en lien). */
  readonly licenseUrl?: string;
}

export interface TodayScreenProps {
  now: Date;
  timeZone: string;
  locale: string;
  civilDate: string;
  logicalDate: string;
  greetingVariants: boolean;
  greetingSeed: number;
  startedToday: boolean;
  lastDayStartedAt: string | null;
  busy: boolean;
  /**
   * Démarre la journée si nécessaire. Résout `false` en cas d'échec : l'écran
   * reste alors sur l'accueil (l'erreur réelle est affichée par les bandeaux).
   */
  onStartDay: () => Promise<boolean>;
  /** Appelé une seule fois après le passage en aperçu (rappels + agenda). */
  onEnterPreview: () => void;
  onRetryReminders: () => void;
  onRetryAgenda: () => void;
  reminders: readonly Reminder[];
  remindersStatus: "idle" | "loading" | "ready" | "error";
  remindersError: DayaliError | null;
  agenda: readonly CalendarItem[];
  agendaStatus: "idle" | "loading" | "ready" | "error";
  agendaError: DayaliError | null;
  agendaWarnings: readonly string[];
  carryOvers: readonly Reminder[];
  /** Fichiers de rappel ignorés à la lecture du calcul des reports. */
  carryOverWarnings: readonly string[];
  onOpenDashboard: () => void;
  /** Bandeaux de la route : erreurs, conflits, fuseau. Jamais masqués. */
  banners?: ReactNode;
  lateNightEnabled?: boolean;
  lateNightAfterHour?: number;
  lateNightShownFor?: string | null;
  onMarkLateNightShown?: () => void;
  onProposeEndOfDay?: () => void;
  /** Absent tant qu'aucune photo réelle n'est approuvée : aucun crédit rendu. */
  photo?: TodayPhoto | null;
  /** Réservé aux tests de rendu de l'état aperçu. */
  initialPhase?: TodayPhase;
}

interface Quote {
  readonly text: string;
  readonly author: string;
}

const QUOTES = bundledQuotes as readonly Quote[];
const INTERACTIVE_SELECTOR = "input, textarea, select, button, a[href], [contenteditable='true']";

function greetingForScreen(hour: number, variants: boolean): string {
  if (hour < 5) return variants ? "La nuit est calme." : "Encore debout ?";
  if (hour < 12) return "Bonjour";
  if (hour < 18) return "Bon après-midi";
  if (hour < 22) return "Bonsoir";
  return "Bonne nuit";
}

/** Libellé naturel de l'heure pour les lecteurs d'écran (« 3 heures 30 minutes »). */
function spokenClock(hour: number, minute: number, locale: string): string {
  if (!locale.toLowerCase().startsWith("fr")) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const hours = `${hour} heure${hour > 1 ? "s" : ""}`;
  if (minute === 0) return hours;
  return `${hours} ${minute} minute${minute > 1 ? "s" : ""}`;
}

/** Citation réelle de la liste embarquée ; `null` plutôt qu'une citation inventée. */
function quoteOfTheDay(seed: number): Quote | null {
  if (QUOTES.length === 0) return null;
  const index = ((seed % QUOTES.length) + QUOTES.length) % QUOTES.length;
  return QUOTES[index] ?? null;
}

/**
 * Accueil plein cadre (SPEC §6) : un seul écran, deux phases en mémoire.
 * Aucune navigation, aucun réglage de vault ici : le dashboard est le seul
 * écran avec coquille et réglages.
 */
export function TodayScreen({
  now,
  timeZone,
  locale,
  civilDate,
  logicalDate,
  greetingVariants,
  greetingSeed,
  startedToday,
  lastDayStartedAt,
  busy,
  onStartDay,
  onEnterPreview,
  onRetryReminders,
  onRetryAgenda,
  reminders,
  remindersStatus,
  remindersError,
  agenda,
  agendaStatus,
  agendaError,
  agendaWarnings,
  carryOvers,
  carryOverWarnings,
  onOpenDashboard,
  banners,
  lateNightEnabled = true,
  lateNightAfterHour = 23,
  lateNightShownFor = null,
  onMarkLateNightShown,
  onProposeEndOfDay,
  photo = null,
  initialPhase = "home",
}: TodayScreenProps) {
  const [phase, setPhase] = useState<TodayPhase>(initialPhase);
  const [starting, setStarting] = useState(false);
  const [cinematicDone, setCinematicDone] = useState(false);
  const greetingRef = useRef<HTMLHeadingElement>(null);
  const [introOffsetY, setIntroOffsetY] = useState<number | null>(null);
  const handleOpenDashboardWithTransition = useCallback(() => {
    onOpenDashboard();
  }, [onOpenDashboard]);

  // Mesure du titre AVANT le premier affichage : il doit démarrer au centre vertical de l'écran.
  // La transformation d'intro est neutralisée le temps de la mesure ; sinon on mesurerait un
  // titre déjà décalé et on obtiendrait un décalage faux (le titre glissait donc deux fois).
  useLayoutEffect(() => {
    if (phase !== "home") return;
    const greetingEl = greetingRef.current;
    if (!greetingEl) return;
    const previousTransform = greetingEl.style.transform;
    greetingEl.style.transform = "none";
    const rect = greetingEl.getBoundingClientRect();
    greetingEl.style.transform = previousTransform;
    const diff = window.innerHeight / 2 - (rect.top + rect.height / 2);
    if (Math.abs(diff) > 2) setIntroOffsetY(diff);
  }, [phase]);

  useEffect(() => {
    if (phase !== "home") return;
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setCinematicDone(true);
      return;
    }
    const timer = setTimeout(() => {
      setCinematicDone(true);
    }, 1100);
    return () => clearTimeout(timer);
  }, [phase]);

  const hour = hourInZone(now, timeZone);
  const minute = minuteInZone(now, timeZone);
  const clock = formatClock(now, timeZone, locale);
  const civilLong = formatLongDate(now, timeZone, locale);
  const greeting = greetingForScreen(hour, greetingVariants);
  const quote = quoteOfTheDay(greetingSeed);
  const primaryLabel = startedToday ? "Voir ma journée" : "Démarrer la journée";

  const showLateNight =
    lateNightEnabled && hour >= lateNightAfterHour && lateNightShownFor !== logicalDate;

  const enterPreview = useCallback(() => {
    setPhase("preview");
    onEnterPreview();
  }, [onEnterPreview]);

  // Après la transition, le bouton d'accueil est démonté : on déplace le focus
  // sur le titre de l'aperçu pour que le clavier et les lecteurs d'écran
  // perçoivent le changement d'état (SPEC §6).
  useEffect(() => {
    if (phase !== "preview") return;
    document.getElementById("preview-title")?.focus();
  }, [phase]);

  const handleStart = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      const started = await onStartDay();
      if (started) enterPreview();
    } finally {
      setStarting(false);
    }
  }, [enterPreview, onStartDay, starting]);

  // `Entrée` n'agit qu'en phase accueil, hors contrôle interactif : si le focus
  // est déjà sur un bouton, le clic natif fait le travail sans double action.
  useEffect(() => {
    if (phase !== "home") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;
      event.preventDefault();
      void handleStart();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleStart, phase]);

  const backgroundStyle = photo
    ? { backgroundImage: `url(${JSON.stringify(photo.src)})` }
    : undefined;

  return (
    <div className={`${styles.screen} ${phase === "preview" ? styles.preview : ""}`.trim()}>
      <div
        className={styles.background}
        style={backgroundStyle}
        data-testid="home-background"
        aria-hidden="true"
      />
      <div className={styles.backgroundBlur} style={backgroundStyle} aria-hidden="true" />
      <div className={styles.veil} aria-hidden="true" />

      <SkipLink />

      {banners ? <div className={styles.banners}>{banners}</div> : null}

      <main id="contenu" tabIndex={-1} className={styles.content} aria-busy={busy || starting}>
        {phase === "home" ? (
          <div className={styles.homeLayout}>
            <div
              className={`${styles.homeHero} ${cinematicDone ? styles.cinematicReady : styles.cinematicIntro}`}
            >
              <h1
                ref={greetingRef}
                className={styles.greeting}
                style={
                  !cinematicDone && introOffsetY !== null
                    ? ({ "--intro-offset-y": `${introOffsetY}px` } as React.CSSProperties)
                    : undefined
                }
              >
                {greeting}
              </h1>
              <div className={styles.heroDetails}>
                <time className={styles.clock} dateTime={`${civilDate}T${clock}:00`}>
                  <span aria-hidden="true">{clock}</span>
                  <span className={styles.srOnly}>{spokenClock(hour, minute, locale)}</span>
                </time>
                <p className={styles.date}>{civilLong}</p>
              </div>
            </div>

            {quote ? (
              <blockquote className={styles.quote} data-testid="daily-quote">
                <p className={styles.quoteText}>« {quote.text} »</p>
                <footer className={styles.quoteAuthor}>{quote.author}</footer>
              </blockquote>
            ) : null}

            {showLateNight ? (
              <div className={styles.lateNight} role="status" data-testid="late-night-banner">
                <p>
                  Il est tard — une journée bien remplie. Voulez-vous faire un bilan rapide avant de
                  vous reposer ?
                </p>
                <div className={styles.lateNightActions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onMarkLateNightShown?.();
                      onProposeEndOfDay?.();
                    }}
                  >
                    Faire le bilan
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onMarkLateNightShown?.();
                    }}
                  >
                    Plus tard
                  </Button>
                </div>
              </div>
            ) : null}

            <div className={styles.startBlock}>
              <Button
                variant="primary"
                size="lg"
                className={styles.primaryAction}
                onClick={() => void handleStart()}
                disabled={busy || starting}
              >
                {primaryLabel}
              </Button>
              <div className={styles.shortcutHint} aria-hidden="true">
                <kbd className={styles.shortcutKey}>Entrée</kbd>
                <span className={styles.shortcutLabel}>Appuyez pour démarrer</span>
              </div>
            </div>
          </div>
        ) : (
          <DayPreview
            now={now}
            locale={locale}
            timeZone={timeZone}
            civilDate={civilDate}
            logicalDate={logicalDate}
            greeting={greeting}
            lastDayStartedAt={lastDayStartedAt}
            reminders={reminders}
            remindersStatus={remindersStatus}
            remindersError={remindersError}
            agenda={agenda}
            agendaStatus={agendaStatus}
            agendaError={agendaError}
            agendaWarnings={agendaWarnings}
            carryOvers={carryOvers}
            carryOverWarnings={carryOverWarnings}
            onRetryReminders={onRetryReminders}
            onRetryAgenda={onRetryAgenda}
            onOpenDashboard={handleOpenDashboardWithTransition}
          />
        )}

        {photo ? (
          <p className={styles.photoCredit} data-testid="photo-credit" title={photo.source}>
            Photo : {photo.credit} · {photo.license}
          </p>
        ) : null}
      </main>
    </div>
  );
}
