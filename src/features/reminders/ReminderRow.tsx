import { useEffect, useRef, useState } from "react";
import type { LocalDate, Reminder, ReminderStatus } from "../../lib/contracts/types";
import { compactDueLabel, isOverdue, reminderUrgency } from "../../lib/reminders";
import { formatLocalDateLong } from "../../lib/time";
import styles from "./RemindersScreen.module.css";

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

/** Comme Apple Rappels : un, deux ou trois « ! » devant le titre. */
const PRIORITY_MARK: Readonly<Record<string, string>> = {
  low: "!",
  medium: "!!",
  high: "!!!",
};

const TITLE_MAX_LENGTH = 200;

interface InlineTitleProps {
  value: string;
  done: boolean;
  disabled: boolean;
  /** Renvoie `false` si l'enregistrement a échoué : le titre revient alors à sa valeur d'origine. */
  onCommit: (title: string) => Promise<boolean>;
}

/**
 * Titre modifiable directement dans la liste : Entrée ou clic ailleurs enregistre, Échap annule.
 * Un titre vide ou inchangé n'écrit rien.
 */
function InlineTitle({ value, done, disabled, onCommit }: InlineTitleProps) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);

  // Le titre peut changer depuis ailleurs (panneau ⓘ, rechargement) : on suit la valeur enregistrée.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = async () => {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    const clean = draft.trim();
    if (!clean || clean === value) {
      setDraft(value);
      return;
    }
    const saved = await onCommit(clean);
    if (!saved) setDraft(value);
  };

  return (
    <input
      type="text"
      className={`${styles.titleInput} ${done ? styles.titleDone : ""}`}
      value={draft}
      maxLength={TITLE_MAX_LENGTH}
      disabled={disabled}
      title={value}
      aria-label="Titre du rappel"
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export interface ReminderRowProps {
  reminder: Reminder;
  listName: string;
  /** Nom de la liste affiché à droite (utile quand il existe plusieurs listes). */
  showListName: boolean;
  logicalDate: LocalDate;
  locale: string;
  busy: boolean;
  onToggle: () => void;
  onRename: (title: string) => Promise<boolean>;
  onOpenInfo: () => void;
}

/**
 * Ligne compacte d'un rappel (modèle Apple Rappels) : case, titre modifiable, échéance et liste à
 * droite, et le ⓘ qui ouvre toutes les autres propriétés (date, heure, priorité, notes, liste…).
 */
export function ReminderRow({
  reminder,
  listName,
  showListName,
  logicalDate,
  locale,
  busy,
  onToggle,
  onRename,
  onOpenInfo,
}: ReminderRowProps) {
  const done = reminder.status === "done";
  const open = reminder.status === "open";
  const overdue = isOverdue(reminder, logicalDate);
  const today = open && reminderUrgency(reminder, logicalDate) === "today";
  const dueText = compactDueLabel(reminder, logicalDate, locale);
  const priority = reminder.priority;

  const classes = [styles.item];
  if (today) classes.push(styles.itemToday);
  if (!open) classes.push(styles.itemDone);

  let dueClass = styles.dueChip;
  if (overdue) dueClass = `${styles.dueChip} ${styles.dueChipOverdue}`;
  else if (open && reminder.dueDate === logicalDate) {
    dueClass = `${styles.dueChip} ${styles.dueChipToday}`;
  }

  return (
    <li className={classes.join(" ")}>
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={done}
        disabled={reminder.status === "cancelled" || busy}
        aria-label={
          done ? `Rouvrir « ${reminder.title} »` : `Marquer « ${reminder.title} » comme terminé`
        }
        onChange={onToggle}
      />
      {priority ? (
        <span className={styles.priorityMark}>
          <span aria-hidden="true">{PRIORITY_MARK[priority]}</span>
          <span className={styles.srOnly}>{PRIORITY_LABEL[priority]}</span>
        </span>
      ) : null}
      <InlineTitle
        value={reminder.title}
        done={!open}
        disabled={reminder.status === "cancelled"}
        onCommit={onRename}
      />
      <span className={styles.rowMeta}>
        {!open ? <span className={styles.srOnly}>{STATUS_LABEL[reminder.status]}</span> : null}
        {reminder.notes ? (
          <span
            className={styles.notesMark}
            role="img"
            aria-label="Contient des notes"
            title="Contient des notes"
          >
            ≡
          </span>
        ) : null}
        {dueText ? (
          <span
            className={dueClass}
            title={reminder.dueDate ? formatLocalDateLong(reminder.dueDate, locale) : undefined}
          >
            {overdue ? <span className={styles.srOnly}>En retard : </span> : null}
            {dueText}
          </span>
        ) : null}
        {showListName ? <span className={styles.listName}>{listName}</span> : null}
      </span>
      <button
        type="button"
        className={styles.infoButton}
        data-testid="reminder-info-btn"
        aria-label={`Propriétés avancées de « ${reminder.title} »`}
        onClick={onOpenInfo}
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
    </li>
  );
}
