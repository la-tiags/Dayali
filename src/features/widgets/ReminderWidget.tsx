import { useEffect, useState } from "react";
import type { Reminder, SavedView, WidgetPlacement } from "../../lib/contracts/types";
import { getIpc } from "../../lib/ipc";
import { remindersView } from "./viewAdapters";

export interface ReminderWidgetProps {
  placement: WidgetPlacement;
  view?: SavedView;
  logicalDate: string;
  injectedItems?: readonly Reminder[];
  injectedWarning?: string;
  injectedError?: string;
}

export function ReminderWidget({
  view,
  logicalDate,
  injectedItems,
  injectedWarning,
  injectedError,
}: ReminderWidgetProps) {
  const adapted = remindersView(view);
  // Un rappel abandonné est conservé pour audit/restauration, jamais affiché
  // dans un widget opérationnel.
  const visibleItems = (value: readonly Reminder[]) =>
    value.filter((item) => item.status !== "abandoned");
  const [items, setItems] = useState<readonly Reminder[] | null>(
    injectedItems ? visibleItems(injectedItems) : null,
  );
  const [warning] = useState(injectedWarning ?? "");
  const [error, setError] = useState(injectedError ?? "");
  const [loading, setLoading] = useState(injectedItems === undefined && adapted.kind === "ready");

  useEffect(() => {
    if (injectedItems !== undefined) {
      setItems(visibleItems(injectedItems));
      setLoading(false);
      setError(injectedError ?? "");
      return;
    }
    if (adapted.kind !== "ready") {
      setItems(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setItems(null);
    setError("");
    void getIpc()
      .reminderList(adapted.filter)
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
  }, [adapted.kind === "ready" ? JSON.stringify(adapted.filter) : "incompatible", injectedItems]);

  return (
    <div aria-busy={loading}>
      {adapted.kind === "incompatible" ? <p role="alert">{adapted.message}</p> : null}
      {loading ? <p aria-live="polite">Chargement des rappels…</p> : null}
      {error ? <p role="alert">Erreur : {error}</p> : null}
      {warning ? <p role="status">Avertissement : {warning}</p> : null}
      {!loading && !error && adapted.kind === "ready" && items?.length === 0 ? (
        <p>Aucun rappel pour cette vue.</p>
      ) : null}
      {!loading && !error && items && items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.title}
              {item.dueDate === logicalDate ? " · aujourd’hui" : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
