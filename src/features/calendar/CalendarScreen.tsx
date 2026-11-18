import type { FormEvent } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import {
  addDays,
  compareAgendaItems,
  eventsOnDate,
  instantToLocalInput,
  isLocalCalendarEvent,
  localInputToInstant,
  weekStartFor,
} from "../../lib/agenda";
import type { CalendarItem, LocalCalendarEvent, LocalDate } from "../../lib/contracts/types";
import { formatLocalDate, logicalDay } from "../../lib/day";
import { userMessage } from "../../lib/ipc/errors";
import {
  formatLocalDateLong,
  localTimeInZone,
  resolveTimeZone,
  systemTimeZone,
} from "../../lib/time";
import { useClock } from "../../lib/useClock";
import { keyWarnings } from "../../lib/warnings";
import { useAppStore } from "../../stores/app.store";
import styles from "./CalendarScreen.module.css";

export type CalendarViewMode = "day" | "week" | "month" | "list";

export interface CalendarScreenProps {
  /** Instant injecté (tests) ; par défaut l'horloge de l'écran. */
  now?: Date;
  /** Fuseau d'affichage injecté ; par défaut celui de la machine. */
  timeZone?: string;
  locale?: string;
  /** Premier jour de la fenêtre ; sinon calculé depuis la journée logique. */
  logicalDate?: LocalDate;
  /** Nombre de jours affichés après le premier jour (défaut : 30). */
  rangeDays?: number;
}

/** Libellé horaire d'un événement : journée entière ou plage locale. */
function eventTimeLabel(item: CalendarItem, locale: string): string {
  if ("date" in item.start) return "Journée entière";
  const start = localTimeInZone(item.start.dateTime, item.start.timeZone, locale);
  if ("date" in item.end) return start;
  const end = localTimeInZone(item.end.dateTime, item.end.timeZone, locale);
  return `${start} – ${end}`;
}

function splitLocalInput(value: string): { date: string; time: string } | null {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (!match) return null;
  return { date: match[1] ?? "", time: match[2] ?? "" };
}

/**
 * Module Agenda (temps 2a / Vague D) : calendrier local avec vues multiples
 * (Jour, Semaine, Mois, Liste), création/édition/suppression avec préconditions de hash.
 *
 * Aucune donnée métier n'est écrite ici : toutes les mutations passent par les
 * actions du store (`loadAgenda`, `saveEvent`, `deleteEvent`), qui n'appellent
 * que l'IPC du vault.
 */
export function CalendarScreen({
  now: injectedNow,
  timeZone: injectedTimeZone,
  locale: injectedLocale,
  logicalDate: injectedLogicalDate,
  rangeDays = 30,
}: CalendarScreenProps) {
  const vault = useAppStore((state) => state.vault);
  const config = useAppStore((state) => state.config);
  const dayState = useAppStore((state) => state.dayState);
  const agenda = useAppStore((state) => state.agenda);
  const agendaRange = useAppStore((state) => state.agendaRange);
  const loadAgenda = useAppStore((state) => state.loadAgenda);
  const reloadAgenda = useAppStore((state) => state.reloadAgenda);
  const saveEvent = useAppStore((state) => state.saveEvent);
  const deleteEvent = useAppStore((state) => state.deleteEvent);

  const clock = useClock(30_000);
  const now = injectedNow ?? clock;
  const resolvedZone = resolveTimeZone(injectedTimeZone ?? systemTimeZone());
  const timeZone = resolvedZone.timeZone;
  const locale = injectedLocale ?? config?.locale ?? "fr-FR";
  const startDate =
    injectedLogicalDate ??
    (config && dayState
      ? logicalDay(now, config.dayStartHour, timeZone)
      : formatLocalDate(now, timeZone));

  const [viewMode, setViewMode] = useState<CalendarViewMode>("list");
  const [anchorDate, setAnchorDate] = useState<LocalDate>(startDate);

  const range = useMemo(() => {
    if (viewMode === "day") {
      return { from: anchorDate, to: anchorDate };
    }
    if (viewMode === "week") {
      const start = weekStartFor(anchorDate, 1);
      return { from: start, to: addDays(start, 6) };
    }
    if (viewMode === "month") {
      const [year, month] = anchorDate.split("-").map(Number) as [number, number];
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
      const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
      return { from: monthStart, to: monthEnd };
    }
    return { from: anchorDate, to: addDays(anchorDate, rangeDays) };
  }, [viewMode, anchorDate, rangeDays]);

  const handlePrev = () => {
    if (viewMode === "day") {
      setAnchorDate(addDays(anchorDate, -1));
    } else if (viewMode === "week") {
      setAnchorDate(addDays(anchorDate, -7));
    } else if (viewMode === "month") {
      const [year, month] = anchorDate.split("-").map(Number) as [number, number];
      const shifted = new Date(Date.UTC(year, month - 2, 1));
      const y = shifted.getUTCFullYear();
      const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
      setAnchorDate(`${y}-${m}-01`);
    } else {
      setAnchorDate(addDays(anchorDate, -30));
    }
  };

  const handleNext = () => {
    if (viewMode === "day") {
      setAnchorDate(addDays(anchorDate, 1));
    } else if (viewMode === "week") {
      setAnchorDate(addDays(anchorDate, 7));
    } else if (viewMode === "month") {
      const [year, month] = anchorDate.split("-").map(Number) as [number, number];
      const shifted = new Date(Date.UTC(year, month, 1));
      const y = shifted.getUTCFullYear();
      const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
      setAnchorDate(`${y}-${m}-01`);
    } else {
      setAnchorDate(addDays(anchorDate, 30));
    }
  };

  const handleToday = () => {
    const todayDate =
      injectedLogicalDate ??
      (config && dayState
        ? logicalDay(now, config.dayStartHour, timeZone)
        : formatLocalDate(now, timeZone));
    setAnchorDate(todayDate);
  };

  const titleId = useId();
  const titleInputId = useId();
  const allDayId = useId();
  const startId = useId();
  const endId = useId();
  const locationId = useId();
  const descriptionId = useId();

  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startDateValue, setStartDateValue] = useState(startDate);
  const [endDateValue, setEndDateValue] = useState(startDate);
  const [startTimeValue, setStartTimeValue] = useState("09:00");
  const [endTimeValue, setEndTimeValue] = useState("10:00");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  /** Fuseau d'origine d'un événement horaire en cours d'édition (sinon celui de l'écran). */
  const [formTimeZone, setFormTimeZone] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  // Chargement initial (ou rechargement si une autre fenêtre était chargée).
  useEffect(() => {
    if (!vault) return;
    if (agendaRange?.from === range.from && agendaRange.to === range.to) return;
    void loadAgenda(range);
  }, [agendaRange, loadAgenda, range, vault]);

  const groups = useMemo(() => {
    const result: { date: LocalDate; items: CalendarItem[] }[] = [];
    for (let cursor = range.from; cursor <= range.to; cursor = addDays(cursor, 1)) {
      const items = eventsOnDate(agenda.items, cursor).slice().sort(compareAgendaItems);
      if (viewMode === "list") {
        if (items.length > 0) result.push({ date: cursor, items });
      } else {
        result.push({ date: cursor, items });
      }
    }
    return result;
  }, [agenda.items, range, viewMode]);

  const listTitle = useMemo(() => {
    if (viewMode === "day") {
      return formatLocalDateLong(anchorDate, locale);
    }
    if (viewMode === "week") {
      return `Semaine du ${formatLocalDateLong(range.from, locale)} au ${formatLocalDateLong(range.to, locale)}`;
    }
    if (viewMode === "month") {
      const [year, month] = anchorDate.split("-").map(Number) as [number, number];
      const dateObj = new Date(Date.UTC(year, month - 1, 1));
      return new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(dateObj);
    }
    return "Jour et 30 jours suivants";
  }, [viewMode, anchorDate, range, locale]);

  const loading = agenda.status === "loading" || agenda.status === "idle";

  const resetForm = () => {
    setEditingId(null);
    setTitle("");
    setAllDay(false);
    setStartDateValue(startDate);
    setEndDateValue(startDate);
    setStartTimeValue("09:00");
    setEndTimeValue("10:00");
    setLocation("");
    setDescription("");
    setFormTimeZone(null);
    setFormError(null);
  };

  const reload = async () => {
    setReloading(true);
    setNotice(null);
    // Recharger pendant une édition repart de la version du vault : garder un
    // brouillon prérempli avec l'ancienne version écraserait la nouvelle.
    if (editingId) resetForm();
    await reloadAgenda();
    setReloading(false);
  };

  const toggleAllDay = (checked: boolean) => {
    setAllDay(checked);
    // Une journée entière a une fin exclusive : au minimum le lendemain.
    if (checked && endDateValue <= startDateValue) {
      setEndDateValue(addDays(startDateValue, 1));
    }
  };

  const beginEdit = (item: LocalCalendarEvent) => {
    setNotice(null);
    setConfirmingId(null);
    setFormError(null);
    setEditingId(item.id);
    setTitle(item.title);
    setLocation(item.location ?? "");
    setDescription(item.description ?? "");
    const allDayEvent = "date" in item.start;
    setAllDay(allDayEvent);
    setFormTimeZone("date" in item.start ? null : item.start.timeZone);
    if ("date" in item.start) {
      setStartDateValue(item.start.date);
      setStartTimeValue("09:00");
    } else {
      const local = instantToLocalInput(item.start.dateTime, item.start.timeZone);
      const split = splitLocalInput(local);
      setStartDateValue(split?.date ?? startDate);
      setStartTimeValue(split?.time ?? "09:00");
    }
    if ("date" in item.end) {
      setEndDateValue(item.end.date);
      setEndTimeValue("10:00");
    } else {
      const local = instantToLocalInput(item.end.dateTime, item.end.timeZone);
      const split = splitLocalInput(local);
      setEndDateValue(split?.date ?? startDate);
      setEndTimeValue(split?.time ?? "10:00");
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setFormError("Le titre de l'événement est obligatoire.");
      return;
    }
    if (!startDateValue || !endDateValue) {
      setFormError("Choisissez une date de début et une date de fin.");
      return;
    }
    // Un événement horaire est édité dans son propre fuseau : le relire dans le
    // fuseau de l'écran puis l'enregistrer ainsi décalerait l'instant.
    const eventTimeZone = allDay ? timeZone : (formTimeZone ?? timeZone);
    if (allDay) {
      if (endDateValue <= startDateValue) {
        setFormError("La fin doit être postérieure au début (fin exclusive).");
        return;
      }
    } else {
      const startInstant = localInputToInstant(
        `${startDateValue}T${startTimeValue}`,
        eventTimeZone,
      );
      const endInstant = localInputToInstant(`${endDateValue}T${endTimeValue}`, eventTimeZone);
      if (!startInstant || !endInstant) {
        setFormError("Dates et heures invalides.");
        return;
      }
      if (Date.parse(endInstant) <= Date.parse(startInstant)) {
        setFormError("La fin doit être postérieure au début.");
        return;
      }
    }
    if (!vault) {
      setFormError("Aucun vault n'est ouvert.");
      return;
    }

    const start = allDay
      ? { date: startDateValue }
      : {
          dateTime: localInputToInstant(`${startDateValue}T${startTimeValue}`, eventTimeZone) ?? "",
          timeZone: eventTimeZone,
        };
    const end = allDay
      ? { date: endDateValue }
      : {
          dateTime: localInputToInstant(`${endDateValue}T${endTimeValue}`, eventTimeZone) ?? "",
          timeZone: eventTimeZone,
        };

    const current = editingId
      ? agenda.items.find(
          (item): item is LocalCalendarEvent => isLocalCalendarEvent(item) && item.id === editingId,
        )
      : undefined;
    if (editingId && !current) {
      setFormError("Cet événement n'est plus présent dans l'agenda. Rechargez la liste.");
      return;
    }

    setFormError(null);
    setSaving(true);
    const editedAt = now.toISOString();
    const draft: LocalCalendarEvent = current
      ? {
          ...current,
          title: cleanTitle,
          description: description.trim() ? description : null,
          location: location.trim() ? location : null,
          allDay,
          start,
          end,
          updatedAt: editedAt,
        }
      : {
          id: "",
          uid: "",
          calendarId: "local",
          title: cleanTitle,
          description: description.trim() ? description : null,
          location: location.trim() ? location : null,
          allDay,
          start,
          end,
          projectId: null,
          machineId: vault.machineId,
          createdAt: editedAt,
          updatedAt: editedAt,
          sequence: 0,
          status: "confirmed",
        };

    const expected = current ? agenda.refs[current.id] : undefined;
    const saved = expected
      ? await saveEvent({ event: draft, expected })
      : await saveEvent({ event: draft });
    setSaving(false);
    if (saved) {
      const wasEditing = Boolean(current);
      resetForm();
      setNotice(wasEditing ? "Événement modifié." : "Événement créé.");
    }
  };

  const remove = async (id: string) => {
    setNotice(null);
    setDeletingId(id);
    const removed = await deleteEvent(id);
    setDeletingId(null);
    if (removed) {
      setConfirmingId(null);
      if (editingId === id) resetForm();
      setNotice("Événement supprimé.");
    }
  };

  return (
    <section className={styles.screen} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title} id={titleId}>
            Agenda
          </h1>
          <p className={styles.meta}>
            {loading
              ? "Chargement de l'agenda…"
              : `${agenda.items.length} événement(s) dans la fenêtre affichée`}
          </p>
        </div>
      </header>

      <section className={styles.viewToolbar} aria-label="Commandes du calendrier">
        <div
          className={styles.viewSwitcher}
          role="tablist"
          aria-label="Vues du calendrier"
          data-view-mode={viewMode}
        >
          {(["day", "week", "month", "list"] as const).map((mode) => {
            const label =
              mode === "day"
                ? "Jour"
                : mode === "week"
                  ? "Semaine"
                  : mode === "month"
                    ? "Mois"
                    : "Liste";
            return (
              <Button
                key={mode}
                size="sm"
                variant={viewMode === mode ? "primary" : "secondary"}
                role="tab"
                aria-selected={viewMode === mode}
                onClick={() => setViewMode(mode)}
              >
                {label}
              </Button>
            );
          })}
        </div>

        <div className={styles.navControls}>
          <Button
            size="sm"
            variant="secondary"
            aria-label="Précédent (période précédente)"
            onClick={handlePrev}
          >
            Précédent
          </Button>
          <Button size="sm" variant="secondary" onClick={handleToday}>
            Aujourd'hui
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label="Suivant (période suivante)"
            onClick={handleNext}
          >
            Suivant
          </Button>
        </div>
      </section>

      {resolvedZone.warning ? (
        <p className={styles.info} role="status" aria-live="polite">
          {resolvedZone.warning}
        </p>
      ) : null}

      {agenda.warnings.length > 0 ? (
        <div className={styles.warningBlock} role="status" data-testid="agenda-warnings">
          <p className={styles.warningTitle}>Fichiers d'agenda ignorés à la lecture</p>
          <ul className={styles.warningList}>
            {keyWarnings(agenda.warnings).map(({ key, message }) => (
              <li key={key}>{message} — fichier non modifié.</li>
            ))}
          </ul>
          <div className={styles.formActions}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void reload()}
              disabled={reloading}
            >
              {reloading ? "Rechargement…" : "Recharger"}
            </Button>
          </div>
        </div>
      ) : null}

      {agenda.error ? (
        <div className={styles.errorBanner} role="alert" aria-live="assertive">
          <div className={styles.errorBody}>
            <p className={styles.errorTitle}>{userMessage(agenda.error)}</p>
            <code className={styles.errorCode}>{agenda.error.code}</code>
            {agenda.error.code === "E_PRECONDITION_FAILED" || agenda.error.code === "E_CONFLICT" ? (
              <p className={styles.errorDetail}>
                Aucune version n'a été écrasée. Rechargez pour repartir de l'état actuel.
              </p>
            ) : null}
          </div>
          <Button size="sm" variant="secondary" onClick={() => void reload()} disabled={reloading}>
            {reloading ? "Rechargement…" : "Recharger"}
          </Button>
        </div>
      ) : null}

      <p className={styles.notice} role="status" aria-live="polite">
        {notice ?? ""}
      </p>

      <section
        className={`${styles.panel} ${editingId ? styles.inspectorCard : ""}`}
        aria-labelledby="calendar-form-title"
      >
        <h2 className={styles.panelTitle} id="calendar-form-title">
          {editingId ? "Inspecteur d'événement (i) — Modifier" : "Ajouter un événement"}
        </h2>
        <form
          className={styles.createForm}
          onSubmit={(event) => void submit(event)}
          aria-busy={saving}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor={titleInputId}>
              Titre de l'événement
            </label>
            <input
              id={titleInputId}
              className={styles.input}
              type="text"
              value={title}
              autoComplete="off"
              required
              aria-invalid={formError?.includes("titre") ? true : undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className={styles.checkboxField}>
            <input
              id={allDayId}
              type="checkbox"
              checked={allDay}
              onChange={(event) => toggleAllDay(event.target.checked)}
            />
            <label className={styles.label} htmlFor={allDayId}>
              Journée entière
            </label>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={startId}>
              Début
            </label>
            <input
              id={startId}
              className={styles.input}
              type={allDay ? "date" : "datetime-local"}
              value={allDay ? startDateValue : `${startDateValue}T${startTimeValue}`}
              required
              onChange={(event) => {
                const value = event.target.value;
                if (allDay) {
                  setStartDateValue(value);
                  return;
                }
                const split = splitLocalInput(value);
                if (split) {
                  setStartDateValue(split.date);
                  setStartTimeValue(split.time);
                }
              }}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={endId}>
              {allDay ? "Fin (exclue)" : "Fin"}
            </label>
            <input
              id={endId}
              className={styles.input}
              type={allDay ? "date" : "datetime-local"}
              value={allDay ? endDateValue : `${endDateValue}T${endTimeValue}`}
              required
              onChange={(event) => {
                const value = event.target.value;
                if (allDay) {
                  setEndDateValue(value);
                  return;
                }
                const split = splitLocalInput(value);
                if (split) {
                  setEndDateValue(split.date);
                  setEndTimeValue(split.time);
                }
              }}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={locationId}>
              Lieu (optionnel)
            </label>
            <input
              id={locationId}
              className={styles.input}
              type="text"
              value={location}
              autoComplete="off"
              onChange={(event) => setLocation(event.target.value)}
            />
          </div>

          <div className={styles.fieldWide}>
            <label className={styles.label} htmlFor={descriptionId}>
              Description (optionnelle, texte simple)
            </label>
            <textarea
              id={descriptionId}
              className={styles.textarea}
              value={description}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className={styles.formActions}>
            <Button type="submit" size="sm" variant="primary" disabled={saving}>
              {saving ? "Enregistrement…" : editingId ? "Enregistrer" : "Ajouter l'événement"}
            </Button>
            {editingId ? (
              <Button size="sm" variant="ghost" onClick={resetForm} disabled={saving}>
                Annuler
              </Button>
            ) : null}
          </div>
        </form>
        {formError ? (
          <p className={styles.formError} role="alert" aria-live="assertive">
            {formError}
          </p>
        ) : null}
      </section>

      <section className={styles.listSection} aria-labelledby="calendar-list-title">
        <div className={styles.headerNavigation}>
          <button
            type="button"
            className={styles.navArrowBtn}
            onClick={handlePrev}
            aria-label="Reculer d'une période"
            title="Reculer"
          >
            ‹
          </button>
          <h2 className={styles.panelTitle} id="calendar-list-title">
            {listTitle}
          </h2>
          <button
            type="button"
            className={styles.navArrowBtn}
            onClick={handleNext}
            aria-label="Avancer d'une période"
            title="Avancer"
          >
            ›
          </button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleToday}
            className={styles.todayQuickBtn}
            aria-label="Revenir au jour courant"
          >
            Aujourd'hui
          </Button>
        </div>

        {loading && agenda.items.length === 0 ? (
          <p className={styles.empty} role="status" aria-live="polite">
            Chargement des événements…
          </p>
        ) : groups.length === 0 ||
          (groups.every((g) => g.items.length === 0) && viewMode === "list") ? (
          <div className={styles.empty} role="status">
            <p>
              {viewMode === "list"
                ? "Aucun événement du jour ni dans les 30 jours suivants."
                : "Aucun événement dans la période affichée."}
            </p>
            <p className={styles.emptyHint}>
              Ajoutez un événement avec le formulaire ci-dessus ; il sera enregistré dans le
              calendrier local du vault.
            </p>
          </div>
        ) : (
          <div className={styles.days} data-testid="calendar-grid">
            {groups.map((group) => (
              <section
                className={styles.day}
                key={group.date}
                aria-labelledby={`day-${group.date}`}
              >
                <h3 className={styles.dayTitle} id={`day-${group.date}`}>
                  {formatLocalDateLong(group.date, locale)}
                </h3>
                {group.items.length === 0 ? (
                  <p className={styles.emptyHint}>Aucun événement ce jour.</p>
                ) : (
                  <ul className={styles.items}>
                    {group.items.map((item) => {
                      const key = isLocalCalendarEvent(item)
                        ? item.id
                        : `${item.uid}:${group.date}`;
                      const localId = isLocalCalendarEvent(item) ? item.id : null;
                      const isConfirming = localId !== null && confirmingId === localId;
                      return (
                        <li className={styles.item} key={`${group.date}:${key}`}>
                          <div className={styles.itemMain}>
                            <div className={styles.itemBody}>
                              <div className={styles.itemHeaderLine}>
                                <h4 className={styles.itemTitle}>{item.title}</h4>
                                {isLocalCalendarEvent(item) ? (
                                  <button
                                    type="button"
                                    className={styles.infoButton}
                                    data-testid="calendar-info-btn"
                                    aria-label={`Inspecter « ${item.title} »`}
                                    onClick={() => beginEdit(item)}
                                  >
                                    <span aria-hidden="true">ⓘ</span>
                                  </button>
                                ) : null}
                              </div>
                              <p className={styles.itemMeta}>
                                <span className={styles.timeBadge}>
                                  {eventTimeLabel(item, locale)}
                                </span>
                                {item.location ? (
                                  <span className={styles.location}>{item.location}</span>
                                ) : null}
                                {item.status !== "confirmed" ? (
                                  <span className={styles.statusBadge}>
                                    {item.status === "cancelled" ? "Annulé" : "Tentative"}
                                  </span>
                                ) : null}
                              </p>
                              {item.description ? (
                                <p className={styles.description}>{item.description}</p>
                              ) : null}
                            </div>
                          </div>

                          {isLocalCalendarEvent(item) ? (
                            <div className={styles.itemActions}>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Modifier « ${item.title} »`}
                                onClick={() => beginEdit(item)}
                              >
                                Modifier
                              </Button>
                              {isConfirming ? (
                                <div
                                  className={styles.confirm}
                                  role="alertdialog"
                                  aria-labelledby={`confirm-title-${item.id}`}
                                >
                                  <p
                                    className={styles.confirmTitle}
                                    id={`confirm-title-${item.id}`}
                                  >
                                    Supprimer « {item.title} » ?
                                  </p>
                                  <p className={styles.confirmDetail}>
                                    L'événement sera déplacé dans la corbeille du vault.
                                  </p>
                                  <div className={styles.formActions}>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      autoFocus
                                      disabled={deletingId === item.id}
                                      onClick={() => void remove(item.id)}
                                    >
                                      {deletingId === item.id
                                        ? "Suppression…"
                                        : "Confirmer la suppression"}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={deletingId === item.id}
                                      onClick={() => setConfirmingId(null)}
                                    >
                                      Annuler
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  aria-label={`Supprimer « ${item.title} »`}
                                  onClick={() => {
                                    setNotice(null);
                                    setConfirmingId(item.id);
                                  }}
                                >
                                  Supprimer
                                </Button>
                              )}
                            </div>
                          ) : (
                            <p className={styles.readOnly}>Flux externe — lecture seule</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
