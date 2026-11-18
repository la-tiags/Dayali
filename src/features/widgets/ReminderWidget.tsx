import { useEffect, useState } from "react";
import type {
  Reminder,
  RemindersFilter,
  SavedView,
  WidgetPlacement,
} from "../../lib/contracts/types";
import { getIpc } from "../../lib/ipc";
import { remindersView } from "./viewAdapters";
import styles from "./widgets.module.css";

export interface ReminderWidgetProps {
  placement: WidgetPlacement;
  view?: SavedView;
  logicalDate: string;
  injectedItems?: readonly Reminder[];
  injectedWarning?: string;
  injectedError?: string;
}

// Un rappel abandonné est conservé pour audit/restauration, jamais affiché
// dans un widget opérationnel.
const visibleItems = (value: readonly Reminder[]) =>
  value.filter((item) => item.status !== "abandoned");

export function ReminderWidget({
  view,
  logicalDate,
  injectedItems,
  injectedWarning,
  injectedError,
}: ReminderWidgetProps) {
  const adapted = remindersView(view);
  // Clé stable du filtre : seul un changement de contenu relance le chargement.
  const filterKey = adapted.kind === "ready" ? JSON.stringify(adapted.filter) : null;
  const [items, setItems] = useState<readonly Reminder[] | null>(
    injectedItems ? visibleItems(injectedItems) : null,
  );
  const warning = injectedWarning ?? "";
  const [error, setError] = useState(injectedError ?? "");
  const [loading, setLoading] = useState(injectedItems === undefined && adapted.kind === "ready");

  useEffect(() => {
    if (injectedItems !== undefined) {
      setItems(visibleItems(injectedItems));
      setLoading(false);
      setError(injectedError ?? "");
      return;
    }
    if (filterKey === null) {
      setItems(null);
      setLoading(false);
      return;
    }
    const filter = JSON.parse(filterKey) as RemindersFilter;
    let active = true;
    setLoading(true);
    setItems(null);
    setError("");
    void getIpc()
      .reminderList(filter)
      .then((result) => {
        if (active) {
          setItems(visibleItems(result));
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setItems(null);
          setLoading(false);
          setError(reason instanceof Error ? reason.message : "Impossible de charger les rappels.");
        }
      });
    return () => {
      active = false;
    };
  }, [filterKey, injectedItems, injectedError]);

  return (
    <div className={styles.container} aria-busy={loading}>
      {adapted.kind === "incompatible" ? <p role="alert">{adapted.message}</p> : null}
      {loading ? <p aria-live="polite">Chargement des rappels…</p> : null}
      {error ? <p role="alert">Erreur : {error}</p> : null}
      {warning ? <p role="status">Avertissement : {warning}</p> : null}
      {!loading && !error && adapted.kind === "ready" && items?.length === 0 ? (
        <p className={styles.empty}>Aucun rappel pour cette vue.</p>
      ) : null}
      {!loading && !error && items && items.length > 0 ? (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.item} title={item.title}>
              <div className={styles.itemMain}>
                <span className={styles.bullet} aria-hidden="true" />
                <span className={styles.title}>{item.title}</span>
              </div>
              {item.dueDate === logicalDate ? (
                <span className={`${styles.dueBadge} ${styles.todayBadge}`}>aujourd’hui</span>
              ) : item.dueDate ? (
                <span className={styles.dueBadge}>{item.dueDate}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
