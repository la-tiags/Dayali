import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import { addDays } from "../../lib/agenda";
import type { LocalDate, Reminder } from "../../lib/contracts/types";
import { normalizeIpcError, userMessage } from "../../lib/ipc/errors";
import styles from "./TodayScreen.module.css";

/** Décision prise depuis l'accueil pour un reste de la journée non fermée. */
export type CarryOverDecision =
  | { readonly action: "replan"; readonly newDueDate: LocalDate }
  | { readonly action: "abandon" };

export interface CarryOverActionsProps {
  reminder: Reminder;
  /** Journée logique courante : « Aujourd'hui » replanifie à cette date. */
  logicalDate: LocalDate;
  onResolve: (reminder: Reminder, decision: CarryOverDecision) => Promise<void>;
}

/**
 * Actions d'un reste de la veille : replanifier aujourd'hui, demain ou un autre
 * jour de la semaine, ou abandonner. Reprend les décisions de l'écran de fin de
 * journée (`reminderReport`) pour une journée qui n'a pas été fermée.
 */
export function CarryOverActions({ reminder, logicalDate, onResolve }: CarryOverActionsProps) {
  const dateId = useId();
  const tomorrow = addDays(logicalDate, 1);
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState<LocalDate>(addDays(logicalDate, 2));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(decision: CarryOverDecision) {
    setPending(true);
    setError(null);
    try {
      await onResolve(reminder, decision);
    } catch (cause) {
      setError(userMessage(normalizeIpcError(cause)));
    } finally {
      // La ligne disparaît d'elle-même une fois l'état de journée relu ; si ce
      // n'est pas le cas, les boutons ne doivent jamais rester bloqués.
      setPending(false);
    }
  }

  const replan = (newDueDate: LocalDate) => void run({ action: "replan", newDueDate });
  const label = (what: string) => `${what} : ${reminder.title}`;

  return (
    <div className={styles.carryActions}>
      <Button
        size="sm"
        variant="primary"
        disabled={pending}
        aria-label={label("Replanifier aujourd'hui")}
        onClick={() => replan(logicalDate)}
      >
        Aujourd'hui
      </Button>
      <Button
        size="sm"
        disabled={pending}
        aria-label={label("Replanifier demain")}
        onClick={() => replan(tomorrow)}
      >
        Demain
      </Button>
      <Button
        size="sm"
        disabled={pending}
        aria-expanded={picking}
        aria-label={label("Choisir un autre jour")}
        onClick={() => setPicking((value) => !value)}
      >
        Un autre jour
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={label("Abandonner")}
        onClick={() => void run({ action: "abandon" })}
      >
        Abandonner
      </Button>
      {picking ? (
        <div className={styles.carryPicker}>
          <label htmlFor={dateId} className={styles.carryPickerLabel}>
            Nouvelle échéance
          </label>
          <input
            id={dateId}
            className={styles.carryDateInput}
            type="date"
            value={date}
            min={logicalDate}
            disabled={pending}
            onChange={(event) => setDate(event.currentTarget.value)}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={pending || date < logicalDate || date === ""}
            aria-label={label("Valider la nouvelle échéance")}
            onClick={() => replan(date)}
          >
            Valider
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className={styles.carryError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
