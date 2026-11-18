import { useEffect, useState } from "react";
import { addDays, compareAgendaItems } from "../../lib/agenda";
import type { CalendarItem, SavedView, WidgetPlacement } from "../../lib/contracts/types";
import { getIpc } from "../../lib/ipc";
import { calendarView } from "./viewAdapters";

export interface CalendarWidgetProps {
  placement: WidgetPlacement;
  view?: SavedView;
  logicalDate: string;
  injectedItems?: readonly CalendarItem[];
  injectedWarnings?: readonly string[];
  injectedError?: string;
}

export function CalendarWidget({
  view,
  logicalDate,
  injectedItems,
  injectedWarnings,
  injectedError,
}: CalendarWidgetProps) {
  const adapted = calendarView(view);
  const [items, setItems] = useState<readonly CalendarItem[] | null>(injectedItems ?? null);
  const [warnings, setWarnings] = useState<readonly string[]>(injectedWarnings ?? []);
  const [error, setError] = useState(injectedError ?? "");
  const [loading, setLoading] = useState(injectedItems === undefined && adapted.kind === "ready");

  useEffect(() => {
    if (injectedItems !== undefined) {
      setItems(injectedItems);
      setWarnings(injectedWarnings ?? []);
      setLoading(false);
      setError(injectedError ?? "");
      return;
    }
    if (adapted.kind !== "ready") {
      setItems(null);
      setWarnings([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setItems(null);
    setWarnings([]);
    setError("");
    void getIpc()
      .calendarList({ from: logicalDate, to: addDays(logicalDate, adapted.filter.rangeDays ?? 0) })
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
  }, [
    logicalDate,
    adapted.kind === "ready" ? JSON.stringify(adapted.filter) : "incompatible",
    injectedItems,
  ]);

  const visible = items
    ?.filter(
      (item) =>
        adapted.kind === "ready" && (adapted.filter.includeAllDay !== false || !item.allDay),
    )
    .sort(compareAgendaItems);
  return (
    <div aria-busy={loading}>
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
      {!loading && !error && adapted.kind === "ready" && visible?.length === 0 ? (
        <p>Aucun événement sur cette période.</p>
      ) : null}
      {!loading && !error && visible && visible.length > 0 ? (
        <ul>
          {visible.map((item) => (
            <li key={`${item.calendarId}-${item.uid}-${JSON.stringify(item.start)}`}>
              {item.title}
              {"date" in item.start && item.start.date === logicalDate ? " · aujourd’hui" : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
