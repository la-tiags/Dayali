import { useEffect, useMemo, useState } from "react";
import {
  addDays,
  calendarItemKey,
  compareAgendaItems,
  eventsOnDate,
  feedAccent,
} from "../../lib/agenda";
import type {
  AgendaFilter,
  CalendarItem,
  LocalDate,
  Reminder,
  SavedView,
  WidgetPlacement,
} from "../../lib/contracts/types";
import { getIpc } from "../../lib/ipc";
import { countDueToday, filterForMaJournee } from "../../lib/reminders";
import { formatLocalDateLong, localTimeInZone } from "../../lib/time";
import { useClock } from "../../lib/useClock";
import { calendarView } from "./viewAdapters";
import styles from "./widgets.module.css";

export interface CalendarWidgetProps {
  placement: WidgetPlacement;
  view?: SavedView;
  logicalDate: string;
  locale?: string;
  /** Instant injecté (tests) ; par défaut l'horloge du widget. */
  now?: Date;
  injectedItems?: readonly CalendarItem[];
  injectedWarnings?: readonly string[];
  injectedError?: string;
  /** Rappels injectés (tests) : sert au compteur de la journée terminée. */
  injectedReminders?: readonly Reminder[];
}

/** Plage horaire lisible d'un événement, dans le fuseau d'origine de l'événement. */
function eventTimeRange(item: CalendarItem, locale: string): string {
  if ("date" in item.start) return "Journée entière";
  const start = localTimeInZone(item.start.dateTime, item.start.timeZone, locale);
  if ("date" in item.end) return start;
  return `${start} – ${localTimeInZone(item.end.dateTime, item.end.timeZone, locale)}`;
}

/** Événement horaire complet : on peut le situer sur l'axe du temps. */
function isTimedEvent(item: CalendarItem): boolean {
  return !("date" in item.start) && !("date" in item.end);
}

function startMs(item: CalendarItem): number {
  return "date" in item.start ? Number.NaN : Date.parse(item.start.dateTime);
}

function endMs(item: CalendarItem): number {
  return "date" in item.end ? Number.NaN : Date.parse(item.end.dateTime);
}

/** Événement commencé mais pas terminé à l'instant donné. */
function isOngoing(item: CalendarItem, nowMs: number): boolean {
  if (!isTimedEvent(item)) return false;
  return startMs(item) <= nowMs && nowMs < endMs(item);
}

/** Avancement d'un événement en cours, borné à [0, 100]. */
function progressPercent(item: CalendarItem, nowMs: number): number {
  const start = startMs(item);
  const end = endMs(item);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const raw = ((nowMs - start) / (end - start)) * 100;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Widget Agenda : une vue par widget (Aujourd'hui, 7 jours, 30 jours).
 *
 * La vue « Aujourd'hui » met en avant l'événement en cours (horaire, lieu,
 * avancement) puis les événements à suivre ; les vues plus larges groupent les
 * événements par jour. Chaque événement expose son horaire et son lieu.
 */
export function CalendarWidget({
  view,
  logicalDate,
  locale: injectedLocale,
  now: injectedNow,
  injectedItems,
  injectedWarnings,
  injectedError,
  injectedReminders,
}: CalendarWidgetProps) {
  const adapted = calendarView(view);
  // Clé stable du filtre : seul un changement de contenu relance le chargement.
  const filterKey = adapted.kind === "ready" ? JSON.stringify(adapted.filter) : null;
  const clock = useClock(30_000);
  const now = injectedNow ?? clock;
  const locale = injectedLocale ?? "fr-FR";
  const [items, setItems] = useState<readonly CalendarItem[] | null>(injectedItems ?? null);
  const [warnings, setWarnings] = useState<readonly string[]>(injectedWarnings ?? []);
  const [error, setError] = useState(injectedError ?? "");
  const [loading, setLoading] = useState(injectedItems === undefined && adapted.kind === "ready");
  // Les calendriers abonnés s'actualisent en arrière-plan : on recharge quand c'est fait.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const onFeedsUpdated = () => setReloadTick((tick) => tick + 1);
    window.addEventListener("dayali:feeds-updated", onFeedsUpdated);
    return () => window.removeEventListener("dayali:feeds-updated", onFeedsUpdated);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadTick` relance volontairement le chargement.
  useEffect(() => {
    if (injectedItems !== undefined) {
      setItems(injectedItems);
      setWarnings(injectedWarnings ?? []);
      setLoading(false);
      setError(injectedError ?? "");
      return;
    }
    if (filterKey === null) {
      setItems(null);
      setWarnings([]);
      setLoading(false);
      return;
    }
    const filter = JSON.parse(filterKey) as AgendaFilter;
    let active = true;
    setLoading(true);
    setItems(null);
    setWarnings([]);
    setError("");
    void getIpc()
      .calendarList({ from: logicalDate, to: addDays(logicalDate, filter.rangeDays ?? 0) })
      .then((result) => {
        if (active) {
          setItems(result.items);
          setWarnings(result.warnings);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setItems(null);
          setLoading(false);
          setError(reason instanceof Error ? reason.message : "Impossible de charger l’agenda.");
        }
      });
    return () => {
      active = false;
    };
  }, [logicalDate, filterKey, injectedItems, injectedWarnings, injectedError, reloadTick]);

  const visible = useMemo(
    () =>
      items
        ?.filter(
          (item) =>
            adapted.kind === "ready" && (adapted.filter.includeAllDay !== false || !item.allDay),
        )
        .sort(compareAgendaItems),
    [items, adapted],
  );

  const rangeDays = adapted.kind === "ready" ? (adapted.filter.rangeDays ?? 1) : 1;
  const dayView = rangeDays <= 1;

  const dayParts = useMemo(() => {
    if (!dayView || !visible) return null;
    const nowMs = now.getTime();
    // La requête IPC couvre `logicalDate → logicalDate + rangeDays` : la vue « Aujourd'hui »
    // doit donc se restreindre au jour logique, sinon le lendemain y apparaît.
    const scope = eventsOnDate(visible, logicalDate);
    const allDay = scope.filter((item) => "date" in item.start);
    const timed = scope.filter(isTimedEvent).sort((left, right) => startMs(left) - startMs(right));
    const current = timed.find((item) => isOngoing(item, nowMs)) ?? null;
    return {
      allDay,
      current,
      // Les événements terminés ne sont plus affichés : le widget ne montre que ce qui reste.
      upcoming: timed.filter((item) => !isOngoing(item, nowMs) && endMs(item) > nowMs),
    };
  }, [dayView, visible, now, logicalDate]);

  const dayIsDone =
    dayView &&
    adapted.kind === "ready" &&
    !loading &&
    !error &&
    dayParts !== null &&
    dayParts.allDay.length === 0 &&
    dayParts.current === null &&
    dayParts.upcoming.length === 0;

  // Tâches qui restent : la journée est « finie » côté agenda, pas forcément côté rappels.
  const [remainingTasks, setRemainingTasks] = useState<number | null>(
    injectedReminders ? countDueToday(injectedReminders, logicalDate) : null,
  );

  useEffect(() => {
    if (injectedReminders !== undefined) {
      setRemainingTasks(countDueToday(injectedReminders, logicalDate));
      return;
    }
    // Aucun aller-retour IPC tant que la journée n'est pas terminée dans le widget.
    if (!dayIsDone) return;
    let active = true;
    void Promise.resolve()
      .then(() => getIpc().reminderList(filterForMaJournee()))
      .then((list) => {
        if (active) setRemainingTasks(countDueToday(list, logicalDate));
      })
      .catch(() => {
        if (active) setRemainingTasks(null);
      });
    return () => {
      active = false;
    };
  }, [dayIsDone, logicalDate, injectedReminders]);

  const dayGroups = useMemo(() => {
    if (!visible || dayView) return [];
    const groups: { date: LocalDate; items: CalendarItem[] }[] = [];
    const last = addDays(logicalDate, rangeDays);
    for (let cursor = logicalDate; cursor <= last; cursor = addDays(cursor, 1)) {
      const dayItems = eventsOnDate(visible, cursor);
      if (dayItems.length > 0) groups.push({ date: cursor, items: dayItems });
    }
    return groups;
  }, [visible, dayView, rangeDays, logicalDate]);

  const nowMs = now.getTime();

  const renderEvent = (item: CalendarItem) => {
    const accent = feedAccent(item).color;
    // La marque « En cours » suit l'instant réel : elle apparaît aussi dans les
    // vues 7/30 jours, où l'événement courant est simplement une ligne du jour.
    const ongoing = isOngoing(item, nowMs);
    return (
      <li
        key={calendarItemKey(item)}
        className={[styles.event, ongoing ? styles.eventOngoing : ""].filter(Boolean).join(" ")}
      >
        <div className={styles.eventLine}>
          <span
            className={styles.bullet}
            aria-hidden="true"
            style={accent ? { backgroundColor: accent } : undefined}
          />
          <span className={styles.eventTitle}>{item.title}</span>
          <span className={styles.eventTime}>{eventTimeRange(item, locale)}</span>
        </div>
        {ongoing || item.location ? (
          <div className={styles.eventMeta}>
            {ongoing ? <span className={styles.eventOngoingBadge}>En cours</span> : null}
            {item.location ? <span className={styles.eventLocation}>{item.location}</span> : null}
          </div>
        ) : null}
      </li>
    );
  };

  const current = dayParts?.current ?? null;

  return (
    <div className={styles.container} aria-busy={loading}>
      {adapted.kind === "incompatible" ? <p role="alert">{adapted.message}</p> : null}
      {loading ? <p aria-live="polite">Chargement de l’agenda…</p> : null}
      {error ? <p role="alert">Erreur : {error}</p> : null}
      {warnings.length > 0 ? (
        <div role="status" aria-label="Avertissements agenda">
          <p>Avertissement de lecture :</p>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!loading && !error && adapted.kind === "ready" && !dayView && visible?.length === 0 ? (
        <p className={styles.empty}>Aucun événement sur cette période.</p>
      ) : null}

      {!loading && !error && dayParts && !dayIsDone ? (
        <div className={styles.scroll}>
          {dayParts.allDay.length > 0 ? (
            <div className={styles.group}>
              <h3 className={styles.groupLabel}>Toute la journée</h3>
              <ul className={styles.groupList}>
                {dayParts.allDay.map((item) => renderEvent(item))}
              </ul>
            </div>
          ) : null}

          {current ? (
            <div className={styles.group}>
              <h3 className={styles.groupLabel}>En cours</h3>
              <div className={styles.currentCard}>
                <div className={styles.currentTop}>
                  <span className={styles.currentBadge}>Maintenant</span>
                  <span className={styles.currentTime}>{eventTimeRange(current, locale)}</span>
                </div>
                <p className={styles.currentTitle}>{current.title}</p>
                {current.location ? (
                  <p className={styles.currentLocation}>{current.location}</p>
                ) : null}
                <div className={styles.currentProgress} aria-hidden="true">
                  <span style={{ width: `${progressPercent(current, nowMs)}%` }} />
                </div>
              </div>
            </div>
          ) : null}

          {dayParts.upcoming.length > 0 ? (
            <div className={styles.group}>
              <h3 className={styles.groupLabel}>À suivre</h3>
              <ul className={styles.groupList}>
                {dayParts.upcoming.map((item) => renderEvent(item))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {dayIsDone ? (
        <div className={styles.dayDone}>
          <span className={styles.dayDoneIcon} aria-hidden="true">
            ✓
          </span>
          <p className={styles.dayDoneTitle}>C’est tout pour aujourd’hui</p>
          {remainingTasks !== null && remainingTasks > 0 ? (
            <p className={styles.dayDoneHint}>
              {remainingTasks === 1
                ? "Il vous reste une tâche à faire, prenez ce temps pour l’avancer 😉"
                : "Il vous reste quelques tâches à faire, prenez ce temps pour les avancer 😉"}
            </p>
          ) : null}
        </div>
      ) : null}

      {!loading && !error && !dayView && dayGroups.length > 0 ? (
        <div className={styles.scroll}>
          {dayGroups.map((group) => (
            <div key={group.date} className={styles.group}>
              <h3 className={styles.groupLabel}>
                {group.date === logicalDate
                  ? "Aujourd’hui"
                  : formatLocalDateLong(group.date, locale)}
              </h3>
              <ul className={styles.groupList}>{group.items.map((item) => renderEvent(item))}</ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
