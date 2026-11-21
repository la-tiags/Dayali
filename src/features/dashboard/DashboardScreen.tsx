import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import type { Config, ReminderList, WidgetPlacement } from "../../lib/contracts/types";
import {
  clampLayout,
  GRID_COLUMNS,
  healLayout,
  resizeLayout,
  resolveLayout,
} from "../../lib/dashboardLayout";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { ReminderWidget } from "../widgets/ReminderWidget";
import styles from "./DashboardScreen.module.css";

export type AddWidgetTarget =
  | { type: "agenda" }
  | { type: "reminders-all" }
  | { type: "reminders-today" }
  | { type: "reminders-list"; listId: string; listName: string };

export interface DashboardScreenProps {
  config: Config;
  logicalDate: string;
  started?: boolean;
  onBackHome: () => void;
  onOpenVaultChooser: () => void;
  busy?: boolean;
  onOpenDashboardOnLaunchChange?: (value: boolean) => void;
  onAddWidget?: (target?: "reminders" | "agenda" | AddWidgetTarget) => void;
  onRemoveWidget?: (id: string) => void;
  onToggleWidget?: (id: string) => void;
  onMoveWidget?: (id: string, direction: "up" | "down" | "left" | "right") => void;
  onResizeWidget?: (id: string, w: number, h: number) => void | Promise<void>;
  onDragWidget?: (id: string, x: number, y: number) => void | Promise<void>;
  onChangeWidgetList?: (widgetId: string, listId: string | null) => void | Promise<void>;
  reminderLists?: readonly ReminderList[];
}

const MODULE_LABEL: Record<WidgetPlacement["module"], string> = {
  agenda: "Agenda",
  reminders: "Rappels",
  journal: "Journal",
  projects: "Projets",
};

const GRID_COLUMN_KEYS = Array.from({ length: GRID_COLUMNS }, (_, index) => `col-${index + 1}`);

const RESIZE_KEYS: Record<string, readonly [number, number]> = {
  ArrowRight: [1, 0],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowUp: [0, -1],
};

/** Aperçu en cours de drag : position proposée (x, y en cellules de grille). */
interface DragPreview {
  id: string;
  x: number;
  y: number;
}

export function DashboardScreen({
  config,
  logicalDate,
  started,
  onBackHome,
  onAddWidget,
  onRemoveWidget,
  onToggleWidget,
  onMoveWidget,
  onResizeWidget,
  onDragWidget,
  onChangeWidgetList,
  reminderLists = [],
}: DashboardScreenProps) {
  const navigate = useNavigate();
  const rowHeight = config.dashboard.rowHeight;
  const gridRef = useRef<HTMLDivElement>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);

  // Aperçu pendant un redimensionnement (taille) ou un déplacement (position).
  const [preview, setPreview] = useState<{ id: string; w: number; h: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);

  // Disposition affichée : layout réparé + preview de resize ou de drag appliqué en direct.
  const widgets = useMemo(() => {
    const healed = healLayout(config.dashboard.widgets);
    if (dragPreview) {
      return resolveLayout(
        healed.map((widget) =>
          widget.id === dragPreview.id
            ? {
                ...widget,
                layout: clampLayout({ ...widget.layout, x: dragPreview.x, y: dragPreview.y }),
              }
            : widget,
        ),
        dragPreview.id,
      );
    }
    if (!preview) return healed;
    return resolveLayout(
      healed.map((widget) =>
        widget.id === preview.id
          ? { ...widget, layout: resizeLayout(widget.layout, preview.w, preview.h) }
          : widget,
      ),
      preview.id,
    );
  }, [config.dashboard.widgets, preview, dragPreview]);

  const commitResize = useCallback(
    (id: string, w: number, h: number) => {
      if (!onResizeWidget) return;
      const clear = () => setPreview(null);
      setPreview({ id, w, h });
      void Promise.resolve(onResizeWidget(id, w, h)).then(clear, clear);
    },
    [onResizeWidget],
  );

  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const showBanner = started === false && !bannerDismissed;

  /** Glisser la poignée de redimensionnement (coin bas-droit). */
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>, widget: WidgetPlacement) => {
    const grid = gridRef.current;
    if (!grid || !onResizeWidget || event.button !== 0) return;
    event.preventDefault();
    const computed = window.getComputedStyle(grid);
    const gapX = Number.parseFloat(computed.columnGap) || 0;
    const gapY = Number.parseFloat(computed.rowGap) || 0;
    const stepX = (grid.clientWidth - gapX * (GRID_COLUMNS - 1)) / GRID_COLUMNS + gapX;
    const stepY = rowHeight + gapY;
    const { w: startW, h: startH } = widget.layout;
    const originX = event.clientX;
    const originY = event.clientY;
    let current = { w: startW, h: startH };

    const onMove = (move: PointerEvent) => {
      const next = resizeLayout(
        widget.layout,
        startW + Math.round((move.clientX - originX) / stepX),
        startH + Math.round((move.clientY - originY) / stepY),
      );
      if (next.w !== current.w || next.h !== current.h) {
        current = { w: next.w, h: next.h };
        setPreview({ id: widget.id, ...current });
      }
    };
    const stop = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (commit && (current.w !== startW || current.h !== startH)) {
        commitResize(widget.id, current.w, current.h);
      } else {
        setPreview(null);
      }
    };
    const onUp = () => stop(true);
    const onCancel = () => stop(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  /** Glisser la poignée de déplacement (haut du widget). */
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, widget: WidgetPlacement) => {
    const grid = gridRef.current;
    if (!grid || !onDragWidget || event.button !== 0) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);

    const computed = window.getComputedStyle(grid);
    const gapX = Number.parseFloat(computed.columnGap) || 0;
    const gapY = Number.parseFloat(computed.rowGap) || 0;
    const colW = (grid.clientWidth - gapX * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    const stepX = colW + gapX || 1;
    const stepY = rowHeight + gapY || 1;

    // Position du coin haut-gauche du widget au moment du pointerdown.
    const gridRect = grid.getBoundingClientRect();
    const startX = widget.layout.x;
    const startY = widget.layout.y;
    // Décalage du pointeur dans le widget (pour drag naturel depuis n'importe quel point).
    const offsetX = event.clientX - gridRect.left - startX * stepX;
    const offsetY = event.clientY - gridRect.top - startY * stepY;

    let current = { x: startX, y: startY };
    setDragPreview({ id: widget.id, ...current });

    const onMove = (move: PointerEvent) => {
      const rawX = Math.round((move.clientX - gridRect.left - offsetX) / stepX);
      const rawY = Math.round((move.clientY - gridRect.top - offsetY) / stepY);
      const clamped = clampLayout({ x: rawX, y: rawY, w: widget.layout.w, h: widget.layout.h });
      if (clamped.x !== current.x || clamped.y !== current.y) {
        current = { x: clamped.x, y: clamped.y };
        setDragPreview({ id: widget.id, ...current });
      }
    };

    const stop = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDragPreview(null);
      if (commit && (current.x !== startX || current.y !== startY)) {
        void Promise.resolve(onDragWidget(widget.id, current.x, current.y));
      }
    };
    const onUp = () => stop(true);
    const onCancel = () => stop(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  /** Flèches clavier sur la poignée de redimensionnement. */
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, widget: WidgetPlacement) => {
    const delta = RESIZE_KEYS[event.key];
    if (!delta || !onResizeWidget) return;
    event.preventDefault();
    const next = resizeLayout(
      widget.layout,
      widget.layout.w + delta[0],
      widget.layout.h + delta[1],
    );
    if (next.w !== widget.layout.w || next.h !== widget.layout.h) {
      commitResize(widget.id, next.w, next.h);
    }
  };

  /** Flèches clavier sur la poignée de déplacement. */
  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, widget: WidgetPlacement) => {
    const dirMap: Record<string, "up" | "down" | "left" | "right"> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    const dir = dirMap[event.key];
    if (!dir || !onMoveWidget) return;
    event.preventDefault();
    onMoveWidget(widget.id, dir);
  };

  const invitationBanner = showBanner ? (
    <div className={styles.invitationBanner}>
      <p className={styles.bannerText}>
        La journée n'est pas encore marquée comme démarrée sur cette machine.
      </p>
      <div className={styles.bannerActions}>
        <Button size="sm" variant="ghost" onClick={onBackHome}>
          Revenir à l'accueil pour la démarrer
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setBannerDismissed(true)}>
          Ignorer pour l'instant
        </Button>
      </div>
    </div>
  ) : null;

  if (widgets.length === 0) {
    return (
      <section className={styles.screen} aria-labelledby="dashboard-title">
        <h1 className={styles.title} id="dashboard-title">
          Dashboard
        </h1>
        {invitationBanner}
        <div className={styles.empty}>
          <h2 className={styles.cardTitle}>Le dashboard est vide</h2>
          <p>
            Aucun widget n'est configuré pour le moment. Ajoutez votre premier widget pour afficher
            vos listes de rappels ou votre agenda.
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={() => navigate("/end-of-day")}>
            Fin de journée
          </Button>
          {onAddWidget ? (
            <div className={styles.addMenuContainer}>
              <Button
                variant="primary"
                onClick={() => setShowAddMenu((prev) => !prev)}
                aria-expanded={showAddMenu}
              >
                + Ajouter un widget
              </Button>
              {showAddMenu ? (
                <div className={styles.addMenuDropdown} role="menu">
                  <button
                    type="button"
                    className={styles.addMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowAddMenu(false);
                      onAddWidget("agenda");
                    }}
                  >
                    📅 Agenda
                  </button>
                  <button
                    type="button"
                    className={styles.addMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowAddMenu(false);
                      onAddWidget({ type: "reminders-all" });
                    }}
                  >
                    📋 Toutes les tâches
                  </button>
                  <button
                    type="button"
                    className={styles.addMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowAddMenu(false);
                      onAddWidget({ type: "reminders-today" });
                    }}
                  >
                    ☀️ Ma journée
                  </button>
                  {reminderLists.map((list) => (
                    <button
                      key={list.id}
                      type="button"
                      className={styles.addMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setShowAddMenu(false);
                        onAddWidget({
                          type: "reminders-list",
                          listId: list.id,
                          listName: list.name,
                        });
                      }}
                    >
                      🏷️ {list.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.screen} aria-labelledby="dashboard-title">
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title} id="dashboard-title">
            Dashboard
          </h1>
        </div>
        <div className={styles.headerActions}>
          <Button
            variant={isEditing ? "primary" : "secondary"}
            onClick={() => setIsEditing(!isEditing)}
          >
            {isEditing ? "Terminer la modification" : "Modifier la disposition"}
          </Button>
          <Button variant="secondary" onClick={() => navigate("/end-of-day")}>
            Fin de journée
          </Button>
          {onAddWidget && isEditing ? (
            <div className={styles.addMenuContainer}>
              <Button
                variant="primary"
                onClick={() => setShowAddMenu((prev) => !prev)}
                aria-expanded={showAddMenu}
              >
                + Ajouter un widget
              </Button>
              {showAddMenu ? (
                <div className={styles.addMenuDropdown} role="menu">
                  <button
                    type="button"
                    className={styles.addMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowAddMenu(false);
                      onAddWidget("agenda");
                    }}
                  >
                    📅 Agenda
                  </button>
                  <button
                    type="button"
                    className={styles.addMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowAddMenu(false);
                      onAddWidget({ type: "reminders-all" });
                    }}
                  >
                    📋 Toutes les tâches
                  </button>
                  <button
                    type="button"
                    className={styles.addMenuItem}
                    role="menuitem"
                    onClick={() => {
                      setShowAddMenu(false);
                      onAddWidget({ type: "reminders-today" });
                    }}
                  >
                    ☀️ Ma journée
                  </button>
                  {reminderLists.map((list) => (
                    <button
                      key={list.id}
                      type="button"
                      className={styles.addMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setShowAddMenu(false);
                        onAddWidget({
                          type: "reminders-list",
                          listId: list.id,
                          listName: list.name,
                        });
                      }}
                    >
                      🏷️ {list.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {invitationBanner}

      <div
        ref={gridRef}
        className={`${styles.grid} ${isEditing ? styles.gridEditing : ""}`}
        style={{ "--row-height": `${rowHeight}px` } as CSSProperties}
      >
        {isEditing ? (
          <div className={styles.gridGuides} aria-hidden="true">
            {GRID_COLUMN_KEYS.map((key) => (
              <span key={key} className={styles.gridGuide} />
            ))}
          </div>
        ) : null}
        {widgets.map((widget) => {
          const view = config.views.find((candidate) => candidate.id === widget.viewId);
          const isDragging = dragPreview?.id === widget.id;
          const isResizing = preview?.id === widget.id;
          return (
            <section
              key={widget.id}
              className={[
                styles.card,
                widget.enabled ? "" : styles.cardDisabled,
                isEditing ? styles.cardEditing : "",
                isResizing ? styles.cardResizing : "",
                isDragging ? styles.cardDragging : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-labelledby={`${widget.id}-title`}
              style={
                {
                  "--card-column": `${widget.layout.x + 1} / span ${widget.layout.w}`,
                  "--card-row": `${widget.layout.y + 1} / span ${widget.layout.h}`,
                } as CSSProperties
              }
            >
              {/* Poignée de déplacement (drag, haut du widget, mode édition) */}
              {isEditing && onDragWidget ? (
                <button
                  type="button"
                  className={styles.dragHandle}
                  aria-label={`Déplacer ${widget.title ?? MODULE_LABEL[widget.module]}`}
                  title="Glisser pour déplacer le widget (ou flèches du clavier)"
                  onPointerDown={(event) => startDrag(event, widget)}
                  onKeyDown={(event) => moveWithKeyboard(event, widget)}
                >
                  <span className={styles.dragGrip} aria-hidden="true">
                    ⠿
                  </span>
                  <span className={styles.dragLabel}>Déplacer</span>
                </button>
              ) : null}

              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle} id={`${widget.id}-title`}>
                  {widget.title ?? MODULE_LABEL[widget.module]}
                </h2>
                {isEditing && widget.module === "reminders" && onChangeWidgetList ? (
                  <select
                    className={styles.listSelect}
                    aria-label={`Changer la liste pour ${widget.title}`}
                    value={
                      view?.filter &&
                      typeof view.filter === "object" &&
                      "listIds" in view.filter &&
                      Array.isArray(view.filter.listIds) &&
                      view.filter.listIds[0]
                        ? view.filter.listIds[0]
                        : view?.filter &&
                            typeof view.filter === "object" &&
                            "dueWithinDays" in view.filter
                          ? "__my_day__"
                          : ""
                    }
                    onChange={(event) =>
                      void onChangeWidgetList(
                        widget.id,
                        event.target.value === "" ? null : event.target.value,
                      )
                    }
                  >
                    <option value="">Toutes les tâches</option>
                    <option value="__my_day__">Ma journée</option>
                    {reminderLists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              {!view ? (
                <p className={styles.cardWarning} role="status">
                  Vue introuvable — Aucune donnée n'a été supprimée
                </p>
              ) : view.module !== widget.module ? (
                <p className={styles.cardWarning} role="alert">
                  Vue incompatible : ce widget attend le module {MODULE_LABEL[widget.module]}.
                  Aucune donnée n'a été supprimée.
                </p>
              ) : null}
              {widget.enabled && widget.module === "reminders" && view?.module === "reminders" ? (
                <ReminderWidget placement={widget} view={view} logicalDate={logicalDate} />
              ) : null}
              {widget.enabled && widget.module === "agenda" && view?.module === "agenda" ? (
                <CalendarWidget placement={widget} view={view} logicalDate={logicalDate} />
              ) : null}
              {!widget.enabled ||
              !view ||
              view.module !== widget.module ||
              (widget.module !== "reminders" && widget.module !== "agenda") ? (
                <div className={styles.placeholder} aria-hidden="true">
                  {MODULE_LABEL[widget.module]} · {view?.name ?? "vue manquante"}
                  {!widget.enabled ? " (Désactivé)" : ""}
                </div>
              ) : null}

              {isEditing && onResizeWidget ? (
                <>
                  {isResizing ? (
                    <span className={styles.sizeBadge} aria-hidden="true">
                      {widget.layout.w} × {widget.layout.h}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={styles.resizeHandle}
                    aria-label={`Redimensionner ${widget.title ?? MODULE_LABEL[widget.module]}`}
                    title="Glisser pour redimensionner (ou flèches du clavier)"
                    onPointerDown={(event) => startResize(event, widget)}
                    onKeyDown={(event) => resizeWithKeyboard(event, widget)}
                  />
                </>
              ) : null}

              {isEditing ? (
                <div className={styles.cardFooterActions}>
                  {onToggleWidget ? (
                    <Button size="sm" variant="ghost" onClick={() => onToggleWidget(widget.id)}>
                      {widget.enabled ? "Désactiver" : "Activer"}
                    </Button>
                  ) : null}
                  {onRemoveWidget ? (
                    <Button size="sm" variant="ghost" onClick={() => onRemoveWidget(widget.id)}>
                      Supprimer
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}
