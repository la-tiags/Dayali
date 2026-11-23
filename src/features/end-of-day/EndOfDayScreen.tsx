import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { photoOfTheDay } from "../../assets/home/photos";
import { isEndOfDayFadeState } from "../../components/layout/EndOfDayTransition";
import { Button } from "../../components/ui/Button";
import { StatusBanners } from "../../components/ui/StatusBanners";
import { addDays } from "../../lib/agenda";
import {
  clearEndOfDayDraft,
  type EndOfDayDraftState,
  loadEndOfDayDraft,
  type QuickAddDraftTask,
  saveEndOfDayDraft,
} from "../../lib/contracts/end-of-day-draft";
import type { CalendarListResult, LocalDate, Reminder } from "../../lib/contracts/types";
import { dayOfYear, formatLocalDate, logicalDay } from "../../lib/day";
import { readCachedHomePhoto } from "../../lib/home-photos";
import { getIpc } from "../../lib/ipc";
import { normalizeIpcError, userMessage } from "../../lib/ipc/errors";
import { formatLocalDateLong, resolveTimeZone, systemTimeZone } from "../../lib/time";
import { useClock } from "../../lib/useClock";
import { useAppStore } from "../../stores/app.store";
import styles from "./EndOfDayScreen.module.css";

export interface EndOfDayScreenProps {
  now?: Date;
  timeZone?: string;
  locale?: string;
  logicalDate?: LocalDate;
}

/**
 * Étoiles filantes : position de départ (%), délai et cycle (s), longueur de traînée (px),
 * angle (deg ; > 90 = vers la gauche) et distance parcourue (vw). Le passage visible ne dure
 * qu'environ 8 % du cycle, soit une demi-seconde à une seconde, comme une vraie météorite.
 */
const SHOOTING_STARS = [
  { top: 5, left: 58, delay: 0.2, cycle: 7, length: 190, angle: 28, dist: 48 },
  { top: 14, left: 16, delay: 1.1, cycle: 9, length: 140, angle: 36, dist: 40 },
  { top: 4, left: 90, delay: 2.4, cycle: 11, length: 230, angle: 148, dist: 52 },
  { top: 22, left: 72, delay: 3.6, cycle: 8, length: 120, angle: 142, dist: 34 },
  { top: 9, left: 36, delay: 5, cycle: 12, length: 170, angle: 24, dist: 44 },
  { top: 27, left: 44, delay: 6.3, cycle: 10, length: 110, angle: 32, dist: 30 },
] as const;

/** Durée de la sortie d'une étape avant l'entrée de la suivante (doit suivre la CSS). */
const STEP_EXIT_MS = 200;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
}

/**
 * Clôture : le formulaire s'efface (500 ms), le ciel finit de tomber seul un instant, puis
 * « Bonne soirée » apparaît. Doit rester cohérent avec la CSS (`closingOut`).
 */
const CLOSING_MS = 950;

const STEP_TITLES = ["Accompli", "À régler", "Demain", "Bilan"] as const;

/** Intensité de la nuit (voile + étoiles) à chaque étape : le ciel s'assombrit au fil du bilan. */
const NIGHT_BY_STEP = [0.15, 0.4, 0.7, 0.9] as const;

const INTENT_LABEL = {
  tomorrow: "Reportée à demain",
  replan: "Replanifiée",
  abandon: "Abandonnée",
  restore: "Restaurée",
} as const;

/** Générateur pseudo-aléatoire à graine fixe : le ciel est identique à chaque rendu. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAR_TONES = ["#ffffff", "#fff3d6", "#d6e4ff", "#ffe8cf"] as const;

/** Étoiles fixes : plus denses en haut, tailles variées, scintillement propre à chacune. */
const STARFIELD = (() => {
  const rand = seededRandom(20_261_118);
  return Array.from({ length: 130 }, () => {
    const top = rand() ** 1.7 * 94;
    const left = rand() * 100;
    const size = 1 + rand() ** 3 * 2.8;
    return {
      key: `${top.toFixed(2)}-${left.toFixed(2)}`,
      top,
      left,
      size,
      glow: size > 2.4,
      color: STAR_TONES[Math.floor(rand() * STAR_TONES.length)] ?? "#ffffff",
      min: 0.06 + rand() * 0.22,
      max: 0.55 + rand() * 0.45,
      duration: 2.2 + rand() * 4.8,
      delay: -rand() * 7,
    };
  });
})();

export function EndOfDayScreen({
  now: injectedNow,
  timeZone: injectedTimeZone,
  locale: injectedLocale,
  logicalDate: injectedLogicalDate,
}: EndOfDayScreenProps) {
  const navigate = useNavigate();
  // Arrivée via le bouton « Fin de journée » : les éléments apparaissent en fondu lent.
  const slowEntry = isEndOfDayFadeState(useLocation().state);
  /** Classe + délai du fondu lent d'arrivée (rien du tout pour une arrivée directe). */
  const entryFade = (delayMs: number) =>
    slowEntry
      ? { className: styles.enterFade, style: { "--enter-delay": `${delayMs}ms` } as CSSProperties }
      : { className: "", style: undefined };
  /**
   * Corps d'étape : le fondu est porté par chaque panneau et non par le conteneur. Une opacité sur
   * le conteneur crée un « backdrop root » et supprimerait le `backdrop-filter` des panneaux
   * pendant toute l'animation (le flou n'arriverait qu'à la fin du fondu).
   */
  const stepEntryFade = (delayMs: number) =>
    slowEntry
      ? {
          className: styles.enterFadeChildren,
          style: { "--enter-delay": `${delayMs}ms` } as CSSProperties,
        }
      : { className: "", style: undefined };
  // All hooks must be called unconditionally at the top level
  const now = useClock(30_000);
  const vault = useAppStore((state) => state.vault);
  const config = useAppStore((state) => state.config);
  const dayState = useAppStore((state) => state.dayState);
  const busy = useAppStore((state) => state.busy);
  const error = useAppStore((state) => state.error);
  const conflictCopy = useAppStore((state) => state.configConflictCopy);
  const reloadConfig = useAppStore((state) => state.reloadConfig);
  const dismissError = useAppStore((state) => state.dismissError);

  const effectiveNow = injectedNow ?? now;
  const resolvedZone = resolveTimeZone(injectedTimeZone ?? systemTimeZone());
  const timeZone = resolvedZone.timeZone;
  const locale = injectedLocale ?? config?.locale ?? "fr-FR";
  const logicalDate =
    injectedLogicalDate ??
    (config && dayState
      ? logicalDay(effectiveNow, config.dayStartHour, timeZone)
      : formatLocalDate(effectiveNow, timeZone));

  const daySeed = dayOfYear(effectiveNow, timeZone);
  const bundledPhoto = photoOfTheDay(daySeed);
  const cachedPhoto = readCachedHomePhoto(logicalDate);
  const photoSrc = cachedPhoto?.src ?? bundledPhoto.src;
  const backgroundStyle = { backgroundImage: `url(${JSON.stringify(photoSrc)})` };

  const vaultRoot = vault?.root ?? "default-vault";
  const tomorrow = addDays(logicalDate, 1);

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [calendarTomorrow, setCalendarTomorrow] = useState<CalendarListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({});
  const [replanDateInputs, setReplanDateInputs] = useState<Record<string, string>>({});
  const [showReplanInputFor, setShowReplanInputFor] = useState<string | null>(null);

  // Draft state
  const [quickAddInput, setQuickAddInput] = useState("");
  const [draftTasks, setDraftTasks] = useState<QuickAddDraftTask[]>([]);
  const [journalNote, setJournalNote] = useState("");
  const [intents, setIntents] = useState<
    Record<
      string,
      { action: "tomorrow" | "replan" | "abandon" | "restore"; newDueDate?: LocalDate }
    >
  >({});
  const [step, setStep] = useState<number>(0);
  const [isFinished, setIsFinished] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [leaving, setLeaving] = useState(false);
  const [closing, setClosing] = useState(false);
  // Pas d'animation de glissement à l'arrivée : l'écran entier apparaît déjà en fondu.
  const [animateSteps, setAnimateSteps] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);
  const [quickAddedCount, setQuickAddedCount] = useState(0);

  const titleId = useId();
  const quickAddId = useId();

  // Chaque étape (et la clôture) s'ouvre en haut de page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on remonte à chaque changement d'étape.
  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [step, isFinished]);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  /** Sortie en fondu de l'étape courante, puis entrée de la suivante. */
  const runAfterExit = (dir: 1 | -1, action: () => void) => {
    setDirection(dir);
    if (prefersReducedMotion()) {
      action();
      return;
    }
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => {
      action();
      setLeaving(false);
    }, STEP_EXIT_MS);
  };

  const goToStep = (target: number) => {
    if (leaving) return;
    setAnimateSteps(true);
    runAfterExit(target > step ? 1 : -1, () => setStep(target));
  };

  const handleCloseNavigation = useCallback(() => {
    navigate("/dashboard");
  }, [navigate]);

  // Load draft on mount
  useEffect(() => {
    const draft = loadEndOfDayDraft(vaultRoot, logicalDate);
    if (draft) {
      setDraftTasks(draft.quickAddTasks);
      setJournalNote(draft.journalNote);
      const mappedIntents: Record<
        string,
        { action: "tomorrow" | "replan" | "abandon" | "restore"; newDueDate?: LocalDate }
      > = {};
      for (const [id, intent] of Object.entries(draft.intents)) {
        mappedIntents[id] = {
          action: intent.action,
          ...(intent.newDueDate ? { newDueDate: intent.newDueDate } : {}),
        };
      }
      setIntents(mappedIntents);
    }
  }, [vaultRoot, logicalDate]);

  // Save draft helper
  const persistDraft = useCallback(
    (currentIntents = intents, currentDraftTasks = draftTasks, currentNote = journalNote) => {
      const state: EndOfDayDraftState = {
        vaultRoot,
        logicalDate,
        intents: Object.fromEntries(
          Object.entries(currentIntents).map(([id, val]) => [
            id,
            {
              reminderId: id,
              action: val.action,
              ...(val.newDueDate ? { newDueDate: val.newDueDate } : {}),
            },
          ]),
        ),
        quickAddTasks: currentDraftTasks,
        journalNote: currentNote,
        updatedAt: new Date().toISOString(),
      };
      saveEndOfDayDraft(state);
    },
    [vaultRoot, logicalDate, intents, draftTasks, journalNote],
  );

  // Load data (reminders and tomorrow's calendar)
  useEffect(() => {
    let mounted = true;
    async function loadData() {
      try {
        setLoading(true);
        setLoadError(null);
        const [remList, calRes] = await Promise.all([
          getIpc().reminderList(),
          getIpc().calendarList({ from: tomorrow, to: tomorrow }),
        ]);
        if (!mounted) return;
        setReminders(remList);
        setCalendarTomorrow(calRes);
      } catch (err) {
        if (!mounted) return;
        setLoadError(userMessage(normalizeIpcError(err)));
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void loadData();
    return () => {
      mounted = false;
    };
  }, [tomorrow]);

  // Reminder action handler (tomorrow, replan, abandon, restore)
  const handleAction = async (
    reminderId: string,
    action: "tomorrow" | "replan" | "abandon" | "restore",
    newDueDate?: LocalDate,
  ) => {
    setTaskErrors((prev) => ({ ...prev, [reminderId]: "" }));
    try {
      const ref = await getIpc().reminderFileRef({ id: reminderId });
      const targetDueDate =
        action === "tomorrow"
          ? tomorrow
          : action === "replan"
            ? (newDueDate ?? tomorrow)
            : undefined;
      const updated = await getIpc().reminderReport({
        reminderId,
        action,
        ...(targetDueDate ? { newDueDate: targetDueDate } : {}),
        expected: ref.hash,
        sourceDay: logicalDate,
        logicalDay: logicalDate,
      });

      setReminders((prev) => prev.map((r) => (r.id === reminderId ? updated : r)));

      const newIntents = {
        ...intents,
        [reminderId]: { action, ...(targetDueDate ? { newDueDate: targetDueDate } : {}) },
      };
      setIntents(newIntents);
      persistDraft(newIntents);
      setShowReplanInputFor(null);
    } catch (err) {
      const msg = userMessage(normalizeIpcError(err));
      setTaskErrors((prev) => ({ ...prev, [reminderId]: msg }));
    }
  };

  // Quick add task for tomorrow
  const handleQuickAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && quickAddInput.trim()) {
      e.preventDefault();
      const newTask: QuickAddDraftTask = {
        tempId: crypto.randomUUID(),
        title: quickAddInput.trim(),
        dueDate: tomorrow,
      };
      const updated = [...draftTasks, newTask];
      setDraftTasks(updated);
      setQuickAddInput("");
      persistDraft(intents, updated, journalNote);
    }
  };

  const removeQuickAdd = (tempId: string) => {
    const updated = draftTasks.filter((t) => t.tempId !== tempId);
    setDraftTasks(updated);
    persistDraft(intents, updated, journalNote);
  };

  // Finalize / Close "Bonne soirée"
  const handleFinish = async () => {
    if (finishing) return;
    setFinishing(true);
    let addedCount = 0;
    for (const task of draftTasks) {
      try {
        await getIpc().reminderSave({
          reminder: {
            schemaVersion: 1,
            id: crypto.randomUUID(),
            listId: reminders[0]?.listId ?? "",
            title: task.title,
            notes: null,
            status: "open",
            dueDate: task.dueDate,
            dueTime: null,
            dueTimeZone: null,
            projectId: null,
            completedAt: null,
            abandonedAt: null,
            recurrence: null,
            sortKey: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            machineId: vault?.machineId ?? "machine",
          },
        });
        addedCount++;
      } catch {
        // ignore partial quick add failure
      }
    }

    setQuickAddedCount(addedCount);
    clearEndOfDayDraft(vaultRoot, logicalDate);
    if (prefersReducedMotion()) {
      setIsFinished(true);
      setFinishing(false);
      return;
    }
    setClosing(true);
    leaveTimer.current = window.setTimeout(() => {
      setIsFinished(true);
      setClosing(false);
      setFinishing(false);
    }, CLOSING_MS);
  };

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

  // Early return ONLY after all hooks have been declared
  if (!vault) {
    return (
      <main className={styles.screen}>
        <p role="status" className={styles.loadingText}>
          Chargement de la fin de journée…
        </p>
      </main>
    );
  }

  const openReminders = reminders.filter((r) => r.status === "open");
  const abandonedReminders = reminders.filter((r) => r.status === "abandoned");
  // Tâches terminées pendant la journée logique en cours (et pas celles des jours précédents).
  const dayStartHour = config?.dayStartHour ?? 0;
  const doneReminders = reminders.filter(
    (r) =>
      r.status === "done" &&
      r.completedAt !== null &&
      logicalDay(r.completedAt, dayStartHour, timeZone) === logicalDate,
  );
  const decisions = Object.values(intents);
  const postponedCount = decisions.filter(
    (i) => i.action === "tomorrow" || i.action === "replan",
  ).length;
  const abandonedCount = decisions.filter((i) => i.action === "abandon").length;
  const addedCount = isFinished ? quickAddedCount : draftTasks.length;
  const tomorrowReminders = reminders.filter(
    (r) =>
      intents[r.id]?.action === "tomorrow" ||
      (intents[r.id]?.action === "replan" && intents[r.id]?.newDueDate === tomorrow),
  );

  const lastStep = STEP_TITLES.length - 1;
  const nightLevel = isFinished || closing ? 1 : (NIGHT_BY_STEP[step] ?? 1);
  const screenStyle = { "--night": nightLevel } as CSSProperties;
  const showSummary = !isFinished && step === lastStep;

  return (
    <div
      className={[styles.screen, isFinished ? styles.screenFinished : ""].filter(Boolean).join(" ")}
      style={screenStyle}
    >
      <div className={styles.background} aria-hidden="true" style={backgroundStyle} />
      <div className={styles.veil} aria-hidden="true" />
      <div className={styles.nightVeil} aria-hidden="true" />
      <div className={styles.starfield} aria-hidden="true">
        {STARFIELD.map((star) => (
          <span
            key={star.key}
            className={[styles.starDot, star.glow ? styles.starDotGlow : ""]
              .filter(Boolean)
              .join(" ")}
            style={
              {
                top: `${star.top}%`,
                left: `${star.left}%`,
                width: `${star.size}px`,
                height: `${star.size}px`,
                backgroundColor: star.color,
                animationDuration: `${star.duration}s`,
                animationDelay: `${star.delay}s`,
                "--tw-min": star.min,
                "--tw-max": star.max,
              } as CSSProperties
            }
          />
        ))}
      </div>
      {isFinished || closing ? (
        <div className={styles.stars} aria-hidden="true">
          {SHOOTING_STARS.map((star) => (
            <span
              key={`${star.top}-${star.left}`}
              className={styles.star}
              style={
                {
                  top: `${star.top}%`,
                  left: `${star.left}%`,
                  animationDelay: `${star.delay}s`,
                  animationDuration: `${star.cycle}s`,
                  "--len": `${star.length}px`,
                  "--angle": `${star.angle}deg`,
                  "--dist": `${star.dist}vw`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      ) : null}

      {banners ? <div className={styles.banners}>{banners}</div> : null}

      <main
        className={[styles.content, slowEntry ? styles.contentSlow : ""].filter(Boolean).join(" ")}
      >
        <div
          className={[
            styles.layout,
            isFinished ? styles.layoutFinished : "",
            closing ? styles.layoutClosing : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {isFinished ? null : (
            <div
              className={[styles.topBar, entryFade(250).className].filter(Boolean).join(" ")}
              style={entryFade(250).style}
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCloseNavigation}
                aria-label="Retour au dashboard"
              >
                ← Retour au dashboard
              </Button>
            </div>
          )}

          <header
            className={[styles.header, entryFade(550).className].filter(Boolean).join(" ")}
            style={entryFade(550).style}
          >
            <p className={styles.eyebrow}>
              {isFinished ? "Fin de journée terminée" : "Fin de journée"} ·{" "}
              {formatLocalDateLong(logicalDate, locale)}
            </p>
            <h1 id={titleId} className={styles.title}>
              {isFinished ? "Bonne soirée ! 🌙" : "Fin de journée"}
            </h1>
            {isFinished ? null : (
              <ol className={styles.stepper} aria-label="Progression">
                {STEP_TITLES.map((label, index) => (
                  <li
                    key={label}
                    className={[
                      styles.stepDot,
                      index === step ? styles.stepDotActive : "",
                      index < step ? styles.stepDotDone : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-current={index === step ? "step" : undefined}
                  >
                    <span className={styles.stepNumber}>{index + 1}</span>
                    <span className={styles.stepName}>{label}</span>
                  </li>
                ))}
              </ol>
            )}
          </header>

          {loadError ? (
            <div role="alert" className={styles.alertBox}>
              Erreur de chargement : {loadError}
            </div>
          ) : null}

          {loading ? (
            <p role="status" className={styles.loadingText}>
              Chargement du bilan…
            </p>
          ) : (
            <>
              {isFinished ? null : (
                <div
                  key={step}
                  style={animateSteps ? undefined : stepEntryFade(850).style}
                  className={[
                    styles.stepBody,
                    !animateSteps
                      ? stepEntryFade(850).className
                      : leaving
                        ? direction === 1
                          ? styles.stepLeaveForward
                          : styles.stepLeaveBack
                        : direction === 1
                          ? styles.stepEnterForward
                          : styles.stepEnterBack,
                  ].join(" ")}
                >
                  {/* Étape 1 : ce qui a été fait */}
                  {!isFinished && step === 0 ? (
                    <section aria-labelledby="step-done" className={styles.section}>
                      <h2 id="step-done" className={styles.sectionTitle}>
                        Accomplissements du jour ({doneReminders.length})
                      </h2>
                      {doneReminders.length === 0 ? (
                        <p className={styles.emptyNote}>Aucune tâche terminée aujourd'hui.</p>
                      ) : (
                        <ul className={styles.taskList}>
                          {doneReminders.map((reminder) => (
                            <li key={reminder.id} className={styles.doneTaskItem}>
                              <span className={styles.doneCheckBadge} aria-hidden="true">
                                ✓
                              </span>
                              <span className={styles.doneTaskTitle}>{reminder.title}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ) : null}

                  {/* Étape 2 : tâches non terminées à reporter / replanifier / abandonner */}
                  {!isFinished && step === 1 ? (
                    <>
                      <section aria-labelledby="unresolved-tasks" className={styles.section}>
                        <h2 id="unresolved-tasks" className={styles.sectionTitle}>
                          Tâches non terminées ({openReminders.length})
                        </h2>
                        {openReminders.length === 0 ? (
                          <p className={styles.emptyNote}>
                            Aucune tâche ouverte. Excellent travail !
                          </p>
                        ) : (
                          <ul className={styles.taskList}>
                            {openReminders.map((reminder) => {
                              const intent = intents[reminder.id];
                              const taskErr = taskErrors[reminder.id];
                              const isReplanOpen = showReplanInputFor === reminder.id;

                              return (
                                <li key={reminder.id} className={styles.taskItem}>
                                  <div className={styles.taskContentRow}>
                                    <div className={styles.taskTitleInfo}>
                                      <strong className={styles.taskTitle}>{reminder.title}</strong>
                                      {reminder.dueDate ? (
                                        <span className={styles.taskDueDate}>
                                          (Échéance : {reminder.dueDate})
                                        </span>
                                      ) : null}
                                      {intent ? (
                                        <span className={styles.taskIntent}>
                                          [{INTENT_LABEL[intent.action]}]
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className={styles.taskActions}>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => void handleAction(reminder.id, "tomorrow")}
                                        aria-label={`Reporter à demain : ${reminder.title}`}
                                      >
                                        Reporter à demain
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                          setShowReplanInputFor(isReplanOpen ? null : reminder.id)
                                        }
                                        aria-label={`Replanifier : ${reminder.title}`}
                                      >
                                        Replanifier…
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => void handleAction(reminder.id, "abandon")}
                                        aria-label={`Abandonner : ${reminder.title}`}
                                      >
                                        Abandonner
                                      </Button>
                                    </div>
                                  </div>

                                  {isReplanOpen ? (
                                    <div className={styles.replanForm}>
                                      <input
                                        type="date"
                                        aria-label="Nouvelle date d'échéance"
                                        className={styles.dateInput}
                                        value={replanDateInputs[reminder.id] ?? tomorrow}
                                        onChange={(e) =>
                                          setReplanDateInputs({
                                            ...replanDateInputs,
                                            [reminder.id]: e.target.value,
                                          })
                                        }
                                      />
                                      <Button
                                        size="sm"
                                        onClick={() =>
                                          void handleAction(
                                            reminder.id,
                                            "replan",
                                            replanDateInputs[reminder.id] ?? tomorrow,
                                          )
                                        }
                                      >
                                        Valider replanification
                                      </Button>
                                    </div>
                                  ) : null}

                                  {taskErr ? (
                                    <div role="alert" className={styles.taskError}>
                                      Erreur : {taskErr}
                                    </div>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>

                      {abandonedReminders.length > 0 ? (
                        <section aria-labelledby="abandoned-section" className={styles.section}>
                          <h2 id="abandoned-section" className={styles.sectionTitle}>
                            Tâches abandonnées ({abandonedReminders.length})
                          </h2>
                          <ul className={styles.taskList}>
                            {abandonedReminders.map((reminder) => (
                              <li key={reminder.id} className={styles.abandonedItem}>
                                <span className={styles.abandonedTitle}>{reminder.title}</span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void handleAction(reminder.id, "restore")}
                                  aria-label={`Restaurer ${reminder.title}`}
                                >
                                  Restaurer
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </>
                  ) : null}

                  {/* Étape 3 : tâches à ajouter pour demain */}
                  {!isFinished && step === 2 ? (
                    <section aria-labelledby="quick-add-section" className={styles.section}>
                      <h2 id="quick-add-section" className={styles.sectionTitle}>
                        Tâches pour demain ({formatLocalDateLong(tomorrow, locale)})
                      </h2>
                      {tomorrowReminders.length > 0 ? (
                        <ul className={styles.taskList}>
                          {tomorrowReminders.map((reminder) => (
                            <li key={reminder.id} className={styles.taskItem}>
                              <div className={styles.taskTitleInfo}>
                                <strong className={styles.taskTitle}>{reminder.title}</strong>
                                <span className={styles.taskIntent}>[Reportée à demain]</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <label htmlFor={quickAddId} className={styles.quickAddLabel}>
                        Ajouter une tâche (Appuyez sur Entrée) :
                      </label>
                      <input
                        id={quickAddId}
                        type="text"
                        value={quickAddInput}
                        onChange={(e) => setQuickAddInput(e.target.value)}
                        onKeyDown={handleQuickAddKeyDown}
                        placeholder="Ex: Préparer la réunion de cadrage..."
                        className={styles.textInput}
                      />
                      {draftTasks.length > 0 ? (
                        <ul className={styles.quickAddList}>
                          {draftTasks.map((t) => (
                            <li key={t.tempId} className={styles.quickAddItem}>
                              <span>{t.title}</span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => removeQuickAdd(t.tempId)}
                              >
                                Supprimer
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  ) : null}

                  {/* Étape 4 : bilan de la journée + agenda de demain */}
                  {showSummary ? (
                    <>
                      <section aria-labelledby="bilan-section" className={styles.section}>
                        <h2 id="bilan-section" className={styles.sectionTitle}>
                          Bilan de la journée
                        </h2>
                        <div className={styles.statsGrid}>
                          <div className={styles.statCard}>
                            <div className={styles.statValue}>{doneReminders.length}</div>
                            <div className={styles.statLabel}>Tâches faites</div>
                          </div>
                          <div className={styles.statCard}>
                            <div className={styles.statValue}>{postponedCount}</div>
                            <div className={styles.statLabel}>Tâches reportées</div>
                          </div>
                          <div className={styles.statCard}>
                            <div className={styles.statValue}>{abandonedCount}</div>
                            <div className={styles.statLabel}>Tâches abandonnées</div>
                          </div>
                          <div className={styles.statCard}>
                            <div className={styles.statValue}>{addedCount}</div>
                            <div className={styles.statLabel}>Ajoutées pour demain</div>
                          </div>
                        </div>
                      </section>

                      <section aria-labelledby="agenda-tomorrow" className={styles.section}>
                        <h2 id="agenda-tomorrow" className={styles.sectionTitle}>
                          Agenda de demain ({formatLocalDateLong(tomorrow, locale)})
                        </h2>
                        {!calendarTomorrow || calendarTomorrow.items.length === 0 ? (
                          <p className={styles.emptyNote}>
                            Aucun événement prévu demain dans l'agenda.
                          </p>
                        ) : (
                          <ul className={styles.taskList}>
                            {calendarTomorrow.items.map((ev) => (
                              <li key={ev.uid} className={styles.agendaItem}>
                                <strong>{ev.title}</strong>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    </>
                  ) : null}
                </div>
              )}

              {/* Navigation entre les étapes */}
              {isFinished ? (
                <div className={styles.finishedBack}>
                  <Button size="sm" variant="ghost" onClick={handleCloseNavigation}>
                    Retour au dashboard
                  </Button>
                </div>
              ) : (
                <div
                  className={[styles.stepNavSlot, entryFade(1150).className]
                    .filter(Boolean)
                    .join(" ")}
                  style={entryFade(1150).style}
                >
                  <div className={styles.navFade} aria-hidden="true" />
                  <div className={styles.stepNav}>
                    {step > 0 ? (
                      <Button variant="ghost" onClick={() => goToStep(step - 1)}>
                        ← Précédent
                      </Button>
                    ) : (
                      <span />
                    )}
                    {step < lastStep ? (
                      <Button variant="primary" onClick={() => goToStep(step + 1)}>
                        Suivant →
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        className={styles.finishButton}
                        disabled={finishing}
                        onClick={() => void handleFinish()}
                      >
                        Bonne soirée 🌙
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
