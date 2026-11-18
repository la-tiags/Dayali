import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Reminder,
  ReminderList,
  RemindersFilter,
  SavedView,
  WidgetPlacement,
} from "../../lib/contracts/types";
import { getIpc } from "../../lib/ipc";
import {
  isOverdue,
  prioritizeReminders,
  reminderUrgency,
  toggleReminderStatus,
} from "../../lib/reminders";
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

/**
 * Un widget est une vue « à faire » : les rappels terminés ou annulés n'y apparaissent pas,
 * sauf si la vue demande explicitement ces statuts. Un rappel abandonné est conservé pour
 * audit/restauration, jamais affiché dans un widget opérationnel.
 */
function visibleItems(value: readonly Reminder[], showFinished: boolean): Reminder[] {
  return value.filter((item) => {
    if (item.status === "abandoned") return false;
    if (!showFinished && (item.status === "done" || item.status === "cancelled")) return false;
    return true;
  });
}

function wantsFinished(filter: RemindersFilter | null): boolean {
  return filter?.statuses?.some((status) => status === "done" || status === "cancelled") ?? false;
}

export function ReminderWidget({
  view,
  logicalDate,
  injectedItems,
  injectedWarning,
  injectedError,
}: ReminderWidgetProps) {
  const adapted = remindersView(view);
  const showFinished = adapted.kind === "ready" && wantsFinished(adapted.filter);
  // Sans statut demandé, la vue charge les rappels ouverts de toutes les listes.
  const effectiveFilter: RemindersFilter | null =
    adapted.kind === "ready"
      ? { ...adapted.filter, statuses: adapted.filter.statuses ?? ["open"] }
      : null;
  // Clé stable du filtre : seul un changement de contenu relance le chargement.
  const filterKey = effectiveFilter ? JSON.stringify(effectiveFilter) : null;
  const [items, setItems] = useState<readonly Reminder[] | null>(
    injectedItems ? visibleItems(injectedItems, showFinished) : null,
  );
  const [lists, setLists] = useState<readonly ReminderList[]>([]);
  const warning = injectedWarning ?? "";
  const [error, setError] = useState(injectedError ?? "");
  const [actionError, setActionError] = useState("");
  const [loading, setLoading] = useState(injectedItems === undefined && adapted.kind === "ready");
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Hash de chaque fichier au chargement : précondition de l'écriture (jamais d'écrasement aveugle).
  const hashes = useRef(new Map<string, string>());

  useEffect(() => {
    if (injectedItems !== undefined) {
      setItems(visibleItems(injectedItems, showFinished));
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
    setActionError("");
    void (async () => {
      try {
        const ipc = getIpc();
        const result = visibleItems(await ipc.reminderList(filter), wantsFinished(filter));
        const refs = await Promise.all(result.map((item) => ipc.reminderFileRef({ id: item.id })));
        const defs = await ipc.reminderListDefs().catch(() => [] as ReminderList[]);
        if (!active) return;
        hashes.current = new Map(result.map((item, index) => [item.id, refs[index]?.hash ?? ""]));
        setLists(defs.filter((list) => !list.archived));
        setItems(result);
        setLoading(false);
      } catch (reason: unknown) {
        if (!active) return;
        setItems(null);
        setLoading(false);
        setError(reason instanceof Error ? reason.message : "Impossible de charger les rappels.");
      }
    })();
    return () => {
      active = false;
    };
  }, [filterKey, injectedItems, injectedError, showFinished]);

  const listById = useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists]);
  const showListName = lists.length > 1;

  const ordered = useMemo(
    () => (items ? prioritizeReminders(items, logicalDate) : []),
    [items, logicalDate],
  );
  const dayItems = ordered.filter((item) => reminderUrgency(item, logicalDate) === "today");
  const laterItems = ordered.filter((item) => reminderUrgency(item, logicalDate) !== "today");

  /** Coche depuis le dashboard : « terminé » (ou « rouvert » si la vue montre les terminés). */
  const toggle = async (reminder: Reminder) => {
    if (pendingId) return;
    setPendingId(reminder.id);
    setActionError("");
    try {
      const ipc = getIpc();
      const expected =
        hashes.current.get(reminder.id) ?? (await ipc.reminderFileRef({ id: reminder.id })).hash;
      const at = new Date().toISOString();
      const nextStatus = reminder.status === "done" ? "open" : "done";
      const saved = await ipc.reminderSave({
        reminder: { ...toggleReminderStatus(reminder, nextStatus, at), updatedAt: at },
        expected,
      });
      hashes.current.set(saved.id, (await ipc.reminderFileRef({ id: saved.id })).hash);
      setItems((current) =>
        current
          ? visibleItems(
              current.map((item) => (item.id === saved.id ? saved : item)),
              showFinished,
            )
          : current,
      );
    } catch (reason: unknown) {
      setActionError(
        reason instanceof Error ? reason.message : "Impossible de mettre à jour ce rappel.",
      );
    } finally {
      setPendingId(null);
    }
  };

  const renderItem = (item: Reminder) => {
    const overdue = isOverdue(item, logicalDate);
    const isDone = item.status === "done";
    const list = listById.get(item.listId);
    return (
      <li key={item.id} className={styles.item} title={item.title}>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={isDone}
          disabled={pendingId === item.id}
          aria-label={
            isDone ? `Rouvrir « ${item.title} »` : `Marquer « ${item.title} » comme terminé`
          }
          onChange={() => void toggle(item)}
        />
        <div className={styles.itemMain}>
          <span className={`${styles.title} ${isDone ? styles.titleDone : ""}`}>{item.title}</span>
        </div>
        {showListName && list ? (
          <span
            className={styles.listBadge}
            style={list.color ? { borderColor: list.color } : undefined}
          >
            {list.name}
          </span>
        ) : null}
        {overdue ? (
          <span className={`${styles.dueBadge} ${styles.overdueBadge}`}>en retard</span>
        ) : item.dueDate === logicalDate ? (
          <span className={`${styles.dueBadge} ${styles.todayBadge}`}>aujourd’hui</span>
        ) : item.dueDate ? (
          <span className={styles.dueBadge}>{item.dueDate}</span>
        ) : null}
      </li>
    );
  };

  const hasBothGroups = dayItems.length > 0 && laterItems.length > 0;

  return (
    <div className={styles.container} aria-busy={loading}>
      {adapted.kind === "incompatible" ? <p role="alert">{adapted.message}</p> : null}
      {loading ? <p aria-live="polite">Chargement des rappels…</p> : null}
      {error ? <p role="alert">Erreur : {error}</p> : null}
      {actionError ? <p role="alert">Erreur : {actionError}</p> : null}
      {warning ? <p role="status">Avertissement : {warning}</p> : null}
      {!loading && !error && adapted.kind === "ready" && items?.length === 0 ? (
        <p className={styles.empty}>Aucun rappel à faire pour cette vue.</p>
      ) : null}
      {!loading && !error && items && items.length > 0 ? (
        <div className={styles.scroll}>
          {dayItems.length > 0 ? (
            <section className={styles.group}>
              {hasBothGroups ? <h3 className={styles.groupLabel}>Aujourd’hui</h3> : null}
              <ul className={styles.groupList}>{dayItems.map(renderItem)}</ul>
            </section>
          ) : null}
          {laterItems.length > 0 ? (
            <section className={`${styles.group} ${styles.groupLater}`}>
              {hasBothGroups ? <h3 className={styles.groupLabel}>Plus tard</h3> : null}
              <ul className={styles.groupList}>{laterItems.map(renderItem)}</ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
