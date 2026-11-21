import { type ReactNode, useMemo } from "react";
import { Button } from "../../components/ui/Button";
import { compareAgendaItems, eventsOnDate } from "../../lib/agenda";
import type { CalendarItem, Reminder } from "../../lib/contracts/types";
import { type DayaliError, userMessage } from "../../lib/ipc/errors";
import { applyRemindersFilter, filterForMaJournee, isOverdue } from "../../lib/reminders";
import {
  formatClock,
  formatLocalDateLong,
  localDateInZone,
  localTimeInZone,
  parseZonedDateTime,
} from "../../lib/time";
import { keyWarnings } from "../../lib/warnings";
import { CarryOverActions, type CarryOverDecision } from "./CarryOverActions";
import styles from "./TodayScreen.module.css";

export interface DayPreviewProps {
  locale: string;
  timeZone: string;
  civilDate: string;
  logicalDate: string;
  greeting: string;
  lastDayStartedAt: string | null;
  reminders: readonly Reminder[];
  remindersStatus: "idle" | "loading" | "ready" | "error";
  remindersError: DayaliError | null;
  agenda: readonly CalendarItem[];
  agendaStatus: "idle" | "loading" | "ready" | "error";
  agendaError: DayaliError | null;
  agendaWarnings: readonly string[];
  carryOvers: readonly Reminder[];
  carryOverWarnings: readonly string[];
  /** Replanifie ou abandonne un reste de la veille ; sans lui, la liste est en lecture seule. */
  onResolveCarryOver?:
    | ((reminder: Reminder, decision: CarryOverDecision) => Promise<void>)
    | undefined;
  onRetryReminders: () => void;
  onRetryAgenda: () => void;
  onOpenDashboard: () => void;
  now?: Date | undefined;
}

/** Libellé horaire d'un événement du jour (journée entière ou plage locale). */
function agendaTimeLabel(item: CalendarItem, locale: string): string {
  if ("date" in item.start) return "Journée entière";
  const start = localTimeInZone(item.start.dateTime, item.start.timeZone, locale);
  if ("date" in item.end) return start;
  const end = localTimeInZone(item.end.dateTime, item.end.timeZone, locale);
  return `${start} – ${end}`;
}

/** Échéance lisible d'un rappel (date longue + heure convertie dans le fuseau d'affichage). */
function dueLabel(reminder: Reminder, displayTimeZone: string, locale: string): string {
  if (!reminder.dueDate) return "Sans échéance";
  if (!reminder.dueTime) return formatLocalDateLong(reminder.dueDate, locale);

  const instant = parseZonedDateTime(
    reminder.dueDate,
    reminder.dueTime,
    reminder.dueTimeZone ?? displayTimeZone ?? "UTC",
  );

  const targetDate = localDateInZone(instant, displayTimeZone);
  const targetTime = formatClock(instant, displayTimeZone, locale);
  return `${formatLocalDateLong(targetDate, locale)} à ${targetTime}`;
}

function ReminderLine({
  reminder,
  locale,
  timeZone,
  logicalDate,
  now,
  actions,
}: {
  reminder: Reminder;
  locale: string;
  timeZone: string;
  logicalDate: string;
  now?: Date | undefined;
  actions?: ReactNode;
}) {
  return (
    <li className={styles.reminder}>
      <span className={styles.reminderTitle}>{reminder.title}</span>
      <span className={styles.reminderDue}>{dueLabel(reminder, timeZone, locale)}</span>
      {isOverdue(reminder, logicalDate, now, timeZone) ? (
        <span className={styles.overdueBadge}>En retard</span>
      ) : null}
      {actions}
    </li>
  );
}

/**
 * Aperçu du jour (SPEC §6) : rappels réels, agenda en état vide honnête et
 * report de la veille uniquement s'il existe. Aucun faux compteur, aucune
 * donnée de démonstration.
 */
export function DayPreview({
  locale,
  timeZone,
  civilDate: _civilDate,
  logicalDate,
  greeting,
  lastDayStartedAt,
  reminders,
  remindersStatus,
  remindersError,
  agenda,
  agendaStatus,
  agendaError,
  agendaWarnings,
  carryOvers,
  carryOverWarnings,
  onResolveCarryOver,
  onRetryReminders,
  onRetryAgenda,
  onOpenDashboard,
  now,
}: DayPreviewProps) {
  const todayReminders = useMemo(
    () => applyRemindersFilter(reminders, filterForMaJournee(), logicalDate),
    [logicalDate, reminders],
  );
  const todayAgenda = useMemo(
    () => eventsOnDate(agenda, logicalDate).slice().sort(compareAgendaItems),
    [agenda, logicalDate],
  );
  const visibleCarryOvers = useMemo(
    () => carryOvers.filter((reminder) => reminder.status !== "abandoned"),
    [carryOvers],
  );
  const carryOverIds = useMemo(
    () => new Set(visibleCarryOvers.map((r) => r.id)),
    [visibleCarryOvers],
  );
  const filteredTodayReminders = useMemo(
    () => todayReminders.filter((reminder) => !carryOverIds.has(reminder.id)),
    [todayReminders, carryOverIds],
  );

  const startedAt =
    lastDayStartedAt !== null ? formatClock(new Date(lastDayStartedAt), timeZone, locale) : null;

  return (
    <div className={styles.previewContent}>
      <header className={styles.previewHeader}>
        <p className={styles.eyebrow}>
          {greeting} · {formatLocalDateLong(logicalDate, locale)}
        </p>
        <h1 className={styles.previewTitle} id="preview-title" tabIndex={-1}>
          Votre journée
        </h1>
        {startedAt ? <p className={styles.previewMeta}>Démarrée à {startedAt}</p> : null}
      </header>

      {carryOverWarnings.length > 0 ? (
        <div className={styles.warningBlock} role="status" data-testid="carry-over-warnings">
          <p className={styles.warningTitle}>Rappels ignorés à la lecture</p>
          <ul className={styles.warningList}>
            {keyWarnings(carryOverWarnings).map(({ key, message }) => (
              <li key={key}>Rappel illisible ignoré : {message} — fichier non modifié.</li>
            ))}
          </ul>
        </div>
      ) : null}

      {visibleCarryOvers.length > 0 ? (
        <section className={styles.panel} aria-labelledby="preview-carry-title">
          <h2 className={styles.panelTitle} id="preview-carry-title">
            Report de la veille
          </h2>
          {onResolveCarryOver ? (
            <p className={styles.carryIntro}>
              Ces tâches n'ont pas été traitées : replanifiez-les pour aujourd'hui, demain ou plus
              tard dans la semaine.
            </p>
          ) : null}
          <ul className={styles.reminderList}>
            {visibleCarryOvers.map((reminder) => (
              <ReminderLine
                key={reminder.id}
                reminder={reminder}
                locale={locale}
                timeZone={timeZone}
                logicalDate={logicalDate}
                now={now}
                actions={
                  onResolveCarryOver ? (
                    <CarryOverActions
                      reminder={reminder}
                      logicalDate={logicalDate}
                      onResolve={onResolveCarryOver}
                    />
                  ) : undefined
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      <div className={styles.previewGrid}>
        <section className={styles.panel} aria-labelledby="preview-reminders-title">
          <h2 className={styles.panelTitle} id="preview-reminders-title">
            Rappels du jour
          </h2>
          {remindersStatus === "loading" || remindersStatus === "idle" ? (
            <p className={styles.note} role="status">
              Chargement des rappels…
            </p>
          ) : null}
          {remindersStatus === "error" ? (
            <div className={styles.errorBlock} role="alert">
              <p>
                {remindersError
                  ? userMessage(remindersError)
                  : "Les rappels n'ont pas pu être chargés."}
              </p>
              <Button size="sm" variant="secondary" onClick={onRetryReminders}>
                Réessayer
              </Button>
            </div>
          ) : null}
          {remindersStatus === "ready" && filteredTodayReminders.length === 0 ? (
            <p className={styles.note}>Aucun rappel à traiter aujourd'hui.</p>
          ) : null}
          {remindersStatus === "ready" && filteredTodayReminders.length > 0 ? (
            <ul className={styles.reminderList}>
              {filteredTodayReminders.map((reminder) => (
                <ReminderLine
                  key={reminder.id}
                  reminder={reminder}
                  locale={locale}
                  timeZone={timeZone}
                  logicalDate={logicalDate}
                  now={now}
                />
              ))}
            </ul>
          ) : null}
        </section>

        <section className={styles.panel} aria-labelledby="preview-agenda-title">
          <h2 className={styles.panelTitle} id="preview-agenda-title">
            Agenda du jour
          </h2>
          {agendaWarnings.length > 0 ? (
            <div className={styles.warningBlock} role="status" data-testid="agenda-warnings">
              <p className={styles.warningTitle}>Événements ignorés à la lecture</p>
              <ul className={styles.warningList}>
                {keyWarnings(agendaWarnings).map(({ key, message }) => (
                  <li key={key}>{message} — fichier non modifié.</li>
                ))}
              </ul>
            </div>
          ) : null}
          {agendaStatus === "loading" || agendaStatus === "idle" ? (
            <p className={styles.note} role="status">
              Chargement de l'agenda…
            </p>
          ) : null}
          {agendaStatus === "error" ? (
            <div className={styles.errorBlock} role="alert">
              <p>{agendaError ? userMessage(agendaError) : "L'agenda n'a pas pu être chargé."}</p>
              <Button size="sm" variant="secondary" onClick={onRetryAgenda}>
                Recharger
              </Button>
            </div>
          ) : null}
          {agendaStatus === "ready" && todayAgenda.length === 0 ? (
            <p className={styles.note}>Aucun événement aujourd'hui.</p>
          ) : null}
          {agendaStatus === "ready" && todayAgenda.length > 0 ? (
            <ul className={styles.agendaList}>
              {todayAgenda.map((item) => (
                <li
                  className={styles.agendaItem}
                  key={
                    "id" in item
                      ? item.id
                      : `${item.calendarId}:${item.uid}:${JSON.stringify(item.occurrenceStart)}`
                  }
                >
                  <span className={styles.agendaTitle}>{item.title}</span>
                  <span className={styles.agendaTime}>{agendaTimeLabel(item, locale)}</span>
                  {item.location ? (
                    <span className={styles.agendaLocation}>{item.location}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <footer className={styles.previewFooter}>
        <Button variant="primary" onClick={onOpenDashboard}>
          Ouvrir le dashboard
        </Button>
      </footer>
    </div>
  );
}
