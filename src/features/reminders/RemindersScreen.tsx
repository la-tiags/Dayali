import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { LocalDate, Reminder, ReminderList, ReminderStatus } from "../../lib/contracts/types";
import { formatLocalDate, logicalDay } from "../../lib/day";
import { userMessage } from "../../lib/ipc/errors";
import {
  applyRemindersFilter,
  filterForMaJournee,
  isOverdue,
  toggleReminderStatus,
} from "../../lib/reminders";
import { formatLocalDateLong, resolveTimeZone, systemTimeZone } from "../../lib/time";
import { useClock } from "../../lib/useClock";
import { useAppStore } from "../../stores/app.store";
import styles from "./RemindersScreen.module.css";

export interface RemindersScreenProps {
  /** Instant injecté (tests) ; par défaut l'horloge de l'écran. */
  now?: Date;
  /** Fuseau d'affichage injecté ; par défaut celui de la machine. */
  timeZone?: string;
  locale?: string;
  /** Journée logique injectée ; sinon calculée depuis la config et l'état de journée. */
  logicalDate?: LocalDate;
}

const STATUS_LABEL: Readonly<Record<ReminderStatus, string>> = {
  open: "À faire",
  done: "Terminé",
  cancelled: "Annulé",
  abandoned: "Abandonné",
};

const PRIORITY_LABEL: Readonly<Record<string, string>> = {
  low: "Priorité basse",
  medium: "Priorité moyenne",
  high: "Priorité haute",
};

function dueLabel(reminder: Reminder, locale: string): string | null {
  if (!reminder.dueDate) return null;
  const date = formatLocalDateLong(reminder.dueDate, locale);
  if (!reminder.dueTime) return date;
  return `${date} à ${reminder.dueTime}`;
}

function sortByOrder(lists: readonly ReminderList[]): ReminderList[] {
  return [...lists].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "fr"));
}

/**
 * Module Rappels (Vague C — Pattern Apple Rappels) :
 * - Saisie rapide en haut de la liste avec Entrée.
 * - Panneau de propriétés avancées `(i)` (date, heure, priorité, notes, récurrence, liste).
 * - Listes claires avec cases à cocher, hiérarchie visuelle, échéances discrètes et séparation des tâches terminées.
 */
export function RemindersScreen({
  now: injectedNow,
  timeZone: injectedTimeZone,
  locale: injectedLocale,
  logicalDate: injectedLogicalDate,
}: RemindersScreenProps) {
  const vault = useAppStore((state) => state.vault);
  const config = useAppStore((state) => state.config);
  const dayState = useAppStore((state) => state.dayState);
  const reminders = useAppStore((state) => state.reminders);
  const activeFilter = useAppStore((state) => state.remindersFilter);
  const loadReminders = useAppStore((state) => state.loadReminders);
  const reloadReminders = useAppStore((state) => state.reloadReminders);
  const saveReminder = useAppStore((state) => state.saveReminder);
  const deleteReminder = useAppStore((state) => state.deleteReminder);

  const clock = useClock(30_000);
  const now = injectedNow ?? clock;
  const resolvedZone = resolveTimeZone(injectedTimeZone ?? systemTimeZone());
  const timeZone = resolvedZone.timeZone;
  const locale = injectedLocale ?? config?.locale ?? "fr-FR";
  const logicalDate =
    injectedLogicalDate ??
    (config && dayState
      ? logicalDay(now, config.dayStartHour, timeZone)
      : formatLocalDate(now, timeZone));

  const titleId = useId();

  const [quickTitle, setQuickTitle] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  // Panneau avancé (i)
  const [inspectingReminder, setInspectingReminder] = useState<Reminder | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editDueTime, setEditDueTime] = useState("");
  const [editPriority, setEditPriority] = useState<"low" | "medium" | "high" | null>(null);
  const [editListId, setEditListId] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(true);

  const lists = useMemo(() => sortByOrder(reminders.lists), [reminders.lists]);
  const availableLists = useMemo(() => lists.filter((list) => !list.archived), [lists]);
  const resolvedListId = availableLists[0]?.id ?? "";
  const listNames = useMemo(() => new Map(lists.map((list) => [list.id, list.name])), [lists]);
  const orderedItems = useMemo(
    () => applyRemindersFilter(reminders.items, null, logicalDate),
    [reminders.items, logicalDate],
  );

  const openItems = useMemo(
    () => orderedItems.filter((item) => item.status === "open"),
    [orderedItems],
  );
  const completedItems = useMemo(
    () =>
      orderedItems.filter(
        (item) =>
          item.status === "done" || item.status === "cancelled" || item.status === "abandoned",
      ),
    [orderedItems],
  );

  // Premier chargement : « Ma journée »
  useEffect(() => {
    if (!vault) return;
    if (reminders.status !== "idle") return;
    void loadReminders(filterForMaJournee());
  }, [vault, reminders.status, loadReminders]);

  const view: "today" | "all" =
    activeFilter === null ? "today" : activeFilter.dueWithinDays === 0 ? "today" : "all";
  const loading = reminders.status === "loading" || reminders.status === "idle";
  const error = reminders.error;
  const conflictLike = error?.code === "E_PRECONDITION_FAILED" || error?.code === "E_CONFLICT";
  const canReload = error?.code === "E_PRECONDITION_FAILED" || error?.retryable === true;

  const changeView = async (next: "today" | "all") => {
    if (next === view) return;
    setNotice(null);
    await loadReminders(next === "today" ? filterForMaJournee() : {});
  };

  const reload = async () => {
    setReloading(true);
    setNotice(null);
    await reloadReminders();
    setReloading(false);
  };

  // Saisie rapide par Entrée (Pattern Apple Rappels)
  const handleQuickCreate = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setNotice(null);
    const cleanTitle = quickTitle.trim();
    if (!cleanTitle) {
      setFormError("Le titre du rappel est obligatoire.");
      return;
    }
    if (!resolvedListId) {
      setFormError("Aucune liste de rappels n'est disponible dans ce vault.");
      return;
    }
    if (!vault) {
      setFormError("Aucun vault n'est ouvert.");
      return;
    }
    setFormError(null);
    setCreating(true);
    const instant = now.toISOString();
    const reminder: Reminder = {
      schemaVersion: 1,
      id: "",
      listId: resolvedListId,
      title: cleanTitle,
      notes: null,
      status: "open",
      dueDate: null,
      dueTime: null,
      dueTimeZone: null,
      projectId: null,
      completedAt: null,
      priority: null,
      recurrence: null,
      sortKey: null,
      createdAt: instant,
      updatedAt: instant,
      machineId: vault.machineId,
    };
    const saved = await saveReminder({ reminder });
    setCreating(false);
    if (saved) {
      setQuickTitle("");
      setNotice("Rappel créé.");
    }
  };

  const openAdvanced = (reminder: Reminder) => {
    setNotice(null);
    setConfirmingId(null);
    setInspectingReminder(reminder);
    setEditTitle(reminder.title);
    setEditNotes(reminder.notes ?? "");
    setEditDueDate(reminder.dueDate ?? "");
    setEditDueTime(reminder.dueTime ?? "");
    setEditPriority(reminder.priority ?? null);
    setEditListId(reminder.listId);
  };

  const saveAdvancedEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!inspectingReminder) return;
    const cleanTitle = editTitle.trim();
    if (!cleanTitle) return;
    if (editDueTime && !editDueDate) return;
    setNotice(null);
    setSavingEdit(true);
    const saved = await saveReminder({
      reminder: {
        ...inspectingReminder,
        title: cleanTitle,
        notes: editNotes.trim() ? editNotes : null,
        dueDate: editDueDate || null,
        dueTime: editDueDate && editDueTime ? editDueTime : null,
        dueTimeZone: editDueDate && editDueTime ? timeZone : null,
        priority: editPriority,
        listId: editListId || inspectingReminder.listId,
        updatedAt: now.toISOString(),
      },
    });
    setSavingEdit(false);
    if (saved) {
      setInspectingReminder(null);
      setNotice("Rappel modifié.");
    }
  };

  const toggle = async (reminder: Reminder) => {
    if (reminder.status === "cancelled") return;
    setNotice(null);
    setTogglingId(reminder.id);
    const nextStatus = reminder.status === "done" ? "open" : "done";
    const toggled = toggleReminderStatus(reminder, nextStatus, now.toISOString());
    const saved = await saveReminder({
      reminder: { ...toggled, updatedAt: now.toISOString() },
    });
    setTogglingId(null);
    if (saved) {
      setNotice(nextStatus === "done" ? "Rappel terminé." : "Rappel rouvert.");
    }
  };

  const remove = async (id: string) => {
    setNotice(null);
    setDeletingId(id);
    const removed = await deleteReminder(id);
    setDeletingId(null);
    if (removed) {
      setConfirmingId(null);
      setNotice("Rappel déplacé dans la corbeille.");
    }
  };

  return (
    <section className={styles.screen} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title} id={titleId}>
            Rappels
          </h1>
          <p className={styles.meta}>
            {loading ? "Chargement…" : `${orderedItems.length} rappel(s) affiché(s)`}
          </p>
        </div>
        <fieldset className={styles.viewSwitch}>
          <legend className={styles.viewSwitchLegend}>Filtre des rappels</legend>
          <Button
            size="sm"
            variant={view === "today" ? "primary" : "secondary"}
            aria-pressed={view === "today"}
            onClick={() => void changeView("today")}
            disabled={loading}
          >
            Ma journée
          </Button>
          <Button
            size="sm"
            variant={view === "all" ? "primary" : "secondary"}
            aria-pressed={view === "all"}
            onClick={() => void changeView("all")}
            disabled={loading}
          >
            Tous
          </Button>
        </fieldset>
      </header>

      {resolvedZone.warning ? (
        <p className={styles.info} role="status" aria-live="polite">
          {resolvedZone.warning}
        </p>
      ) : null}

      {error ? (
        <div className={styles.errorBanner} role="alert" aria-live="assertive">
          <div className={styles.errorBody}>
            <p className={styles.errorTitle}>{userMessage(error)}</p>
            <code className={styles.errorCode}>{error.code}</code>
            {conflictLike ? (
              <p className={styles.errorDetail}>
                Une copie de conflit est conservée dans le vault ; rien n'a été écrasé.
                {canReload ? " Rechargez pour repartir de l'état actuel." : ""}
              </p>
            ) : null}
          </div>
          {canReload ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void reload()}
              disabled={reloading}
            >
              {reloading ? "Rechargement…" : "Recharger"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className={styles.notice} role="status" aria-live="polite">
        {notice ?? ""}
      </p>

      {/* Saisie rapide Apple Rappels */}
      <div className={styles.quickInputContainer}>
        <input
          type="text"
          className={styles.quickInput}
          placeholder="+ Ajouter un rappel (appuyez sur Entrée)…"
          value={quickTitle}
          disabled={creating || availableLists.length === 0}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => void handleQuickCreate(e)}
          aria-label="Titre du nouveau rappel"
        />
        {formError ? (
          <p className={styles.formError} role="alert" aria-live="polite">
            {formError}
          </p>
        ) : null}
      </div>

      <section className={styles.listSection} aria-labelledby="reminders-list-title">
        <h2 className={styles.panelTitle} id="reminders-list-title">
          {view === "today" ? "Ma journée" : "Tous les rappels"}
        </h2>

        {loading ? (
          <p className={styles.empty} role="status" aria-live="polite">
            Chargement des rappels…
          </p>
        ) : orderedItems.length === 0 ? (
          <div className={styles.empty} role="status">
            <p>
              {view === "today"
                ? "Aucun rappel ouvert à traiter aujourd'hui."
                : "Aucun rappel dans ce vault pour le moment."}
            </p>
            <p className={styles.emptyHint}>
              {view === "today"
                ? "Les rappels sans échéance ou prévus plus tard apparaissent dans « Tous »."
                : "Tapez un titre ci-dessus et appuyez sur Entrée pour ajouter un rappel."}
            </p>
          </div>
        ) : (
          <div className={styles.listsContainer}>
            {/* Tâches ouvertes / à faire */}
            <ul className={styles.items}>
              {openItems.map((reminder) => {
                const overdue = isOverdue(reminder, logicalDate);
                const listName = listNames.get(reminder.listId) ?? reminder.listId;
                const due = dueLabel(reminder, locale);
                const isConfirming = confirmingId === reminder.id;
                const priority = reminder.priority;
                return (
                  <li key={reminder.id} className={styles.item}>
                    <div className={styles.itemMain}>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={reminder.status === "done"}
                        disabled={reminder.status === "cancelled" || togglingId === reminder.id}
                        aria-label={
                          reminder.status === "done"
                            ? `Rouvrir « ${reminder.title} »`
                            : `Marquer « ${reminder.title} » comme terminé`
                        }
                        onChange={() => void toggle(reminder)}
                      />
                      <div className={styles.itemBody}>
                        <div className={styles.itemHeaderLine}>
                          <h3 className={styles.itemTitle}>{reminder.title}</h3>
                          <button
                            type="button"
                            className={styles.infoButton}
                            data-testid="reminder-info-btn"
                            aria-label={`Propriétés avancées de « ${reminder.title} »`}
                            onClick={() => openAdvanced(reminder)}
                          >
                            <span aria-hidden="true">ⓘ</span>
                          </button>
                        </div>
                        <p className={styles.itemMeta}>
                          <span className={styles.statusBadge}>
                            {STATUS_LABEL[reminder.status]}
                          </span>
                          <span className={styles.listName}>{listName}</span>
                          <span>{due ? `Échéance : ${due}` : "Sans échéance"}</span>
                          {priority ? (
                            <span className={styles.priorityBadge}>{PRIORITY_LABEL[priority]}</span>
                          ) : null}
                          {overdue ? <span className={styles.overdue}>En retard</span> : null}
                        </p>
                        {reminder.notes ? <p className={styles.notes}>{reminder.notes}</p> : null}
                      </div>
                    </div>

                    <div className={styles.itemActions}>
                      {isConfirming ? (
                        <div
                          className={styles.confirm}
                          role="alertdialog"
                          aria-labelledby={`confirm-title-${reminder.id}`}
                          aria-describedby={`confirm-detail-${reminder.id}`}
                        >
                          <p className={styles.confirmTitle} id={`confirm-title-${reminder.id}`}>
                            Supprimer « {reminder.title} » ?
                          </p>
                          <p className={styles.confirmDetail} id={`confirm-detail-${reminder.id}`}>
                            Le rappel sera déplacé dans la corbeille, pas effacé du disque.
                          </p>
                          <div className={styles.formActions}>
                            <Button
                              size="sm"
                              variant="secondary"
                              autoFocus
                              disabled={deletingId === reminder.id}
                              onClick={() => void remove(reminder.id)}
                            >
                              {deletingId === reminder.id
                                ? "Suppression…"
                                : "Confirmer la suppression"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={deletingId === reminder.id}
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
                          onClick={() => {
                            setNotice(null);
                            setConfirmingId(reminder.id);
                          }}
                        >
                          Supprimer
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Tâches terminées séparées */}
            {completedItems.length > 0 ? (
              <div className={styles.completedSection}>
                <button
                  type="button"
                  className={styles.completedToggle}
                  onClick={() => setShowCompleted(!showCompleted)}
                  aria-expanded={showCompleted}
                >
                  <span>Terminés ({completedItems.length})</span>
                  <span aria-hidden="true">{showCompleted ? "▲ Masquer" : "▼ Afficher"}</span>
                </button>
                {showCompleted ? (
                  <ul className={styles.items}>
                    {completedItems.map((reminder) => {
                      const listName = listNames.get(reminder.listId) ?? reminder.listId;
                      const due = dueLabel(reminder, locale);
                      const isConfirming = confirmingId === reminder.id;
                      return (
                        <li key={reminder.id} className={`${styles.item} ${styles.itemDone}`}>
                          <div className={styles.itemMain}>
                            <input
                              type="checkbox"
                              className={styles.checkbox}
                              checked={reminder.status === "done"}
                              disabled={togglingId === reminder.id}
                              aria-label={`Rouvrir « ${reminder.title} »`}
                              onChange={() => void toggle(reminder)}
                            />
                            <div className={styles.itemBody}>
                              <div className={styles.itemHeaderLine}>
                                <h3 className={`${styles.itemTitle} ${styles.titleDone}`}>
                                  {reminder.title}
                                </h3>
                                <button
                                  type="button"
                                  className={styles.infoButton}
                                  aria-label={`Propriétés avancées de « ${reminder.title} »`}
                                  onClick={() => openAdvanced(reminder)}
                                >
                                  <span aria-hidden="true">ⓘ</span>
                                </button>
                              </div>
                              <p className={styles.itemMeta}>
                                <span className={styles.statusBadge}>
                                  {STATUS_LABEL[reminder.status]}
                                </span>
                                <span className={styles.listName}>{listName}</span>
                                <span>{due ? `Échéance : ${due}` : "Sans échéance"}</span>
                              </p>
                              {reminder.notes ? (
                                <p className={styles.notes}>{reminder.notes}</p>
                              ) : null}
                            </div>
                          </div>

                          <div className={styles.itemActions}>
                            {isConfirming ? (
                              <div
                                className={styles.confirm}
                                role="alertdialog"
                                aria-labelledby={`confirm-title-${reminder.id}`}
                                aria-describedby={`confirm-detail-${reminder.id}`}
                              >
                                <p
                                  className={styles.confirmTitle}
                                  id={`confirm-title-${reminder.id}`}
                                >
                                  Supprimer « {reminder.title} » ?
                                </p>
                                <div className={styles.formActions}>
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    autoFocus
                                    disabled={deletingId === reminder.id}
                                    onClick={() => void remove(reminder.id)}
                                  >
                                    Supprimer
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
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
                                onClick={() => {
                                  setNotice(null);
                                  setConfirmingId(reminder.id);
                                }}
                              >
                                Supprimer
                              </Button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>

      {/* Panneau secondaire / popover avancé (i) */}
      {inspectingReminder ? (
        <div
          className={styles.advancedOverlay}
          role="dialog"
          aria-labelledby="advanced-title"
          data-testid="reminder-advanced-dialog"
        >
          <div className={styles.advancedPanel}>
            <div className={styles.advancedHeader}>
              <h3 id="advanced-title" className={styles.panelTitle}>
                Propriétés avancées du rappel
              </h3>
              <Button size="sm" variant="ghost" onClick={() => setInspectingReminder(null)}>
                Fermer
              </Button>
            </div>
            <form
              className={styles.advancedForm}
              onSubmit={(e) => void saveAdvancedEdit(e)}
              aria-busy={savingEdit}
            >
              <div className={styles.field}>
                <label className={styles.label} htmlFor="adv-title">
                  Titre
                </label>
                <input
                  id="adv-title"
                  className={styles.input}
                  type="text"
                  value={editTitle}
                  required
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="adv-list">
                  Liste
                </label>
                <select
                  id="adv-list"
                  className={styles.input}
                  value={editListId}
                  onChange={(e) => setEditListId(e.target.value)}
                >
                  {availableLists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="adv-duedate">
                  Date d'échéance
                </label>
                <input
                  id="adv-duedate"
                  className={styles.input}
                  type="date"
                  value={editDueDate}
                  onChange={(e) => {
                    setEditDueDate(e.target.value);
                    if (!e.target.value) setEditDueTime("");
                  }}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="adv-duetime">
                  Heure d'échéance
                </label>
                <input
                  id="adv-duetime"
                  className={styles.input}
                  type="time"
                  value={editDueTime}
                  disabled={!editDueDate}
                  onChange={(e) => setEditDueTime(e.target.value)}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="adv-priority">
                  Priorité
                </label>
                <select
                  id="adv-priority"
                  className={styles.input}
                  value={editPriority ?? ""}
                  onChange={(e) =>
                    setEditPriority(
                      e.target.value ? (e.target.value as "low" | "medium" | "high") : null,
                    )
                  }
                >
                  <option value="">Aucune</option>
                  <option value="low">Basse</option>
                  <option value="medium">Moyenne</option>
                  <option value="high">Haute</option>
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="adv-notes">
                  Notes (markdown)
                </label>
                <textarea
                  id="adv-notes"
                  className={styles.textarea}
                  value={editNotes}
                  rows={4}
                  onChange={(e) => setEditNotes(e.target.value)}
                />
              </div>

              <div className={styles.formActions}>
                <Button type="submit" size="sm" variant="primary" disabled={savingEdit}>
                  {savingEdit ? "Enregistrement…" : "Enregistrer"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={savingEdit}
                  onClick={() => setInspectingReminder(null)}
                >
                  Annuler
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
