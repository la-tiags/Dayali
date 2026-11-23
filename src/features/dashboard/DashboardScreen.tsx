import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router";
import {
  END_OF_DAY_FADE_STATE,
  EndOfDayTransition,
} from "../../components/layout/EndOfDayTransition";
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

/** Vues d'agenda proposées à la création d'un widget (une par période utile). */
export type AgendaWidgetView = "day" | "week" | "month";

export type AddWidgetTarget =
  | { type: "agenda"; view: AgendaWidgetView }
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

const AGENDA_MENU_ITEMS: readonly { view: AgendaWidgetView; label: string }[] = [
  { view: "day", label: "📅 Aujourd'hui" },
  { view: "week", label: "🗓️ 7 jours" },
  { view: "month", label: "🗓️ 30 jours" },
];

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

/** Position libre (en pixels, relative à la grille) du widget saisi, qui suit le pointeur. */
interface DragFree {
  id: string;
  left: number;
  top: number;
  /** Pas d'une cellule de grille, pour recaler le widget sur son emplacement. */
  stepX: number;
  stepY: number;
}

/** Éléments sur lesquels un appui ne doit pas déclencher un déplacement. */
const NO_DRAG_SELECTOR =
  "button, select, input, textarea, a, label, [role='button'], [role='checkbox'], [contenteditable='true']";

/** Distance (px) à partir de laquelle un appui devient un déplacement. */
const DRAG_THRESHOLD = 4;

const SNAP_EASING = "cubic-bezier(0.22, 0.8, 0.3, 1)";

function motionAllowed(): boolean {
  return !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/**
 * Force une recomposition complète après un geste : WKWebView conserve parfois des tuiles peintes
 * (le fond qui « dessine ») malgré l'invalidation. Le changement d'opacité est invisible mais
 * provoque un nouveau rendu de la page. Le double `requestAnimationFrame` attend que la nouvelle
 * disposition ait été peinte.
 */
function flushRepaint() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.style.opacity = "0.999";
      requestAnimationFrame(() => {
        document.body.style.opacity = "";
      });
    });
  });
}

/**
 * Anime en douceur (FLIP) les widgets dont l'emplacement change dans la grille : quand un widget
 * est déplacé, les autres glissent vers leur nouvelle place au lieu de sauter.
 */
function useFlipLayout(
  gridRef: RefObject<HTMLDivElement | null>,
  layoutKey: string,
  skipId: string | null,
) {
  const previous = useRef(new Map<string, { x: number; y: number }>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `layoutKey` résume la disposition.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const gridRect = grid.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    for (const element of grid.querySelectorAll<HTMLElement>("[data-flip-id]")) {
      const id = element.dataset.flipId;
      if (!id) continue;
      const position = { x: element.offsetLeft, y: element.offsetTop };
      next.set(id, position);
      const before = previous.current.get(id);
      if (!before || id === skipId || !motionAllowed()) continue;
      // Décalage déjà en cours (animation interrompue) à conserver pour ne pas « sauter ».
      const rect = element.getBoundingClientRect();
      const inflightX = rect.left - gridRect.left - grid.clientLeft - position.x;
      const inflightY = rect.top - gridRect.top - grid.clientTop - position.y;
      const dx = before.x - position.x + inflightX;
      const dy = before.y - position.y + inflightY;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      for (const animation of element.getAnimations()) animation.cancel();
      element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 260, easing: SNAP_EASING },
      );
    }
    previous.current = next;
  }, [layoutKey, skipId, gridRef]);
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
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handleNavigateToEndOfDay = () => {
    setIsTransitioning(true);
  };

  // Aperçu pendant un redimensionnement (taille) ou un déplacement (position).
  const [preview, setPreview] = useState<{ id: string; w: number; h: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [dragFree, setDragFree] = useState<DragFree | null>(null);
  // Redimensionnement en cours : la taille libre est écrite dans le style du widget (voir
  // startResize) ; cet état ne change qu'au début et à la fin du geste.
  const [resizingId, setResizingId] = useState<string | null>(null);
  // Pendant un redimensionnement, rien ne change dans la grille : le repère de taille libre, la
  // case visée et son badge sont des calques posés dans <body> (voir startResize). Le tableau de
  // bord n'est donc rendu qu'au début et à la fin du geste.

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

  const layoutKey = widgets
    .map(
      (widget) =>
        `${widget.id}:${widget.layout.x},${widget.layout.y},${widget.layout.w},${widget.layout.h}`,
    )
    .join("|");
  useFlipLayout(gridRef, layoutKey, dragFree?.id ?? resizingId);

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

  /**
   * Redimensionnement libre : le coin du widget suit le pointeur pixel par pixel ; une case en
   * pointillés montre la taille retenue, et à la dépose le widget glisse jusqu'à cette taille.
   */
  const startResize = (event: ReactPointerEvent<HTMLButtonElement>, widget: WidgetPlacement) => {
    const grid = gridRef.current;
    if (!grid || !onResizeWidget || event.button !== 0) return;
    event.preventDefault();
    const card = event.currentTarget.closest<HTMLElement>("[data-flip-id]");
    if (!card) return;

    const computed = window.getComputedStyle(grid);
    const gapX = Number.parseFloat(computed.columnGap) || 0;
    const gapY = Number.parseFloat(computed.rowGap) || 0;
    const colW = (grid.clientWidth - gapX * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    const stepX = colW + gapX || 1;
    const stepY = rowHeight + gapY || 1;
    const spanW = (cells: number) => cells * colW + (cells - 1) * gapX;
    const spanH = (cells: number) => cells * rowHeight + (cells - 1) * gapY;

    const smallest = resizeLayout(widget.layout, 0, 0);
    const largest = resizeLayout(widget.layout, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const bounds = {
      minW: spanW(smallest.w),
      maxW: spanW(largest.w),
      minH: spanH(smallest.h),
      maxH: spanH(largest.h),
    };

    const { w: startW, h: startH } = widget.layout;
    const startRect = card.getBoundingClientRect();
    const originX = event.clientX;
    const originY = event.clientY;
    let current = { w: startW, h: startH };
    let free = { width: startRect.width, height: startRect.height };
    let active = false;
    let previewed = false;

    // Repères du geste : des calques vides posés au-dessus du tableau de bord, hors de la grille.
    // Redimensionner le widget (ou seulement déplacer sa case cible) à chaque frame obligeait
    // WKWebView à re-layoutiser et repeindre la grille, ce qui laissait des traînées : le widget
    // « dessinait » sur le fond. Ici la grille ne bouge plus du tout pendant le geste ; le widget
    // ne prend sa taille qu'à la dépose.
    let ghost: HTMLDivElement | null = null;
    let slot: HTMLDivElement | null = null;
    let badge: HTMLSpanElement | null = null;
    const ensureOverlays = () => {
      if (ghost) return;
      ghost = document.createElement("div");
      ghost.className = styles.resizeGhost ?? "";
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.left = `${startRect.left}px`;
      ghost.style.top = `${startRect.top}px`;
      ghost.style.width = `${startRect.width}px`;
      ghost.style.height = `${startRect.height}px`;
      slot = document.createElement("div");
      slot.className = styles.resizeSlot ?? "";
      slot.setAttribute("aria-hidden", "true");
      slot.style.left = `${startRect.left}px`;
      slot.style.top = `${startRect.top}px`;
      slot.style.width = `${spanW(startW)}px`;
      slot.style.height = `${spanH(startH)}px`;
      badge = document.createElement("span");
      badge.className = styles.sizeBadge ?? "";
      badge.textContent = `${startW} × ${startH}`;
      slot.append(badge);
      document.body.append(ghost, slot);
    };
    const applyFreeSize = () => {
      if (!ghost) return;
      ghost.style.width = `${Math.round(free.width)}px`;
      ghost.style.height = `${Math.round(free.height)}px`;
    };
    const applyTargetCell = () => {
      if (!slot || !badge) return;
      slot.style.width = `${spanW(current.w)}px`;
      slot.style.height = `${spanH(current.h)}px`;
      badge.textContent = `${current.w} × ${current.h}`;
    };
    const removeOverlays = () => {
      ghost?.remove();
      slot?.remove();
      ghost = null;
      slot = null;
      badge = null;
    };

    const onMove = (move: PointerEvent) => {
      if (!active) {
        if (Math.hypot(move.clientX - originX, move.clientY - originY) < 2) return;
        active = true;
        // Calques posés une fois le geste engagé, puis pilotés en DOM : aucun rendu React.
        ensureOverlays();
        setResizingId(widget.id);
      }
      free = {
        width: Math.min(
          bounds.maxW,
          Math.max(bounds.minW, startRect.width + move.clientX - originX),
        ),
        height: Math.min(
          bounds.maxH,
          Math.max(bounds.minH, startRect.height + move.clientY - originY),
        ),
      };
      applyFreeSize();
      const next = resizeLayout(
        widget.layout,
        Math.round((free.width + gapX) / stepX),
        Math.round((free.height + gapY) / stepY),
      );
      if (!previewed || next.w !== current.w || next.h !== current.h) {
        previewed = true;
        current = { w: next.w, h: next.h };
        applyTargetCell();
      }
    };
    const stop = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (!active) return;

      // Les calques disparaissent et le widget prend sa taille de grille d'un coup : aucune taille
      // libre ne reste dans son style, et rien n'est animé en largeur/hauteur (cette animation
      // re-layoutisait le widget à chaque frame, exactement comme le geste lui-même).
      removeOverlays();
      flushSync(() => setResizingId(null));

      if (commit && (current.w !== startW || current.h !== startH)) {
        commitResize(widget.id, current.w, current.h);
      } else {
        setPreview(null);
      }
      // Après le nouveau rendu : WKWebView garde parfois des tuiles peintes en cache, ce changement
      // d'opacité imperceptible force une recomposition complète de la page.
      flushRepaint();
    };
    const onUp = () => stop(true);
    const onCancel = () => stop(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  /**
   * Déplacement libre : on saisit le widget n'importe où (hors contrôles), il suit le pointeur
   * pixel par pixel ; à la dépose il se cale sur la grille en glissant jusqu'à sa case.
   */
  const startDrag = (event: ReactPointerEvent<HTMLElement>, widget: WidgetPlacement) => {
    const grid = gridRef.current;
    if (!grid || !onDragWidget || event.button !== 0) return;
    if ((event.target as HTMLElement).closest(NO_DRAG_SELECTOR)) return;
    // Colonne unique (petite fenêtre) : pas de position libre.
    if (window.matchMedia?.("(width <= 56.25rem)").matches) return;
    event.preventDefault();

    const card = event.currentTarget;
    const computed = window.getComputedStyle(grid);
    const gapX = Number.parseFloat(computed.columnGap) || 0;
    const gapY = Number.parseFloat(computed.rowGap) || 0;
    const colW = (grid.clientWidth - gapX * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    const stepX = colW + gapX || 1;
    const stepY = rowHeight + gapY || 1;

    const startX = widget.layout.x;
    const startY = widget.layout.y;
    const originX = event.clientX;
    const originY = event.clientY;
    // Point saisi dans le widget : il reste sous le pointeur pendant tout le déplacement.
    const cardRect = card.getBoundingClientRect();
    const grabX = event.clientX - cardRect.left;
    const grabY = event.clientY - cardRect.top;

    let active = false;
    let current = { x: startX, y: startY };
    let free = { left: startX * stepX, top: startY * stepY };

    const onMove = (move: PointerEvent) => {
      if (!active) {
        if (Math.hypot(move.clientX - originX, move.clientY - originY) < DRAG_THRESHOLD) return;
        active = true;
        setDragPreview({ id: widget.id, ...current });
      }
      const rect = grid.getBoundingClientRect();
      free = {
        left: move.clientX - rect.left - grid.clientLeft - grabX,
        top: move.clientY - rect.top - grid.clientTop - grabY,
      };
      setDragFree({ id: widget.id, ...free, stepX, stepY });
      const clamped = clampLayout({
        x: Math.round(free.left / stepX),
        y: Math.round(free.top / stepY),
        w: widget.layout.w,
        h: widget.layout.h,
      });
      if (clamped.x !== current.x || clamped.y !== current.y) {
        current = { x: clamped.x, y: clamped.y };
        setDragPreview({ id: widget.id, ...current });
      }
    };

    const stop = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (!active) return;

      const target = commit ? current : { x: startX, y: startY };
      // Le widget lâché glisse de sa position libre vers sa case.
      const fromX = free.left - target.x * stepX;
      const fromY = free.top - target.y * stepY;
      flushSync(() => setDragFree(null));
      if (motionAllowed()) {
        card.style.zIndex = "10";
        const settle = card.animate(
          [
            { transform: `translate3d(${fromX}px, ${fromY}px, 0) scale(1.02)` },
            { transform: "translate3d(0, 0, 0) scale(1)" },
          ],
          { duration: 240, easing: SNAP_EASING },
        );
        settle.onfinish = () => {
          card.style.zIndex = "";
        };
        settle.oncancel = settle.onfinish;
      }

      const moved = commit && (target.x !== startX || target.y !== startY);
      if (moved) {
        // L'aperçu reste jusqu'à l'enregistrement : pas de retour furtif à l'ancienne case.
        const clear = () => setDragPreview(null);
        void Promise.resolve(onDragWidget(widget.id, target.x, target.y)).then(clear, clear);
      } else {
        setDragPreview(null);
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

  /** Flèches clavier sur le widget lui-même (mode édition) : déplacement case par case. */
  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>, widget: WidgetPlacement) => {
    if (event.target !== event.currentTarget) return;
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
        {isTransitioning ? (
          <EndOfDayTransition
            onCovered={() => navigate("/end-of-day", { state: END_OF_DAY_FADE_STATE })}
          />
        ) : null}
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
          <button
            type="button"
            className={styles.endOfDayButton}
            onClick={handleNavigateToEndOfDay}
            aria-label="Fin de journée"
          >
            <span className={styles.endOfDayIcon} aria-hidden="true">
              🌙
            </span>
            <span>Fin de journée</span>
          </button>
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
                  {AGENDA_MENU_ITEMS.map(({ view, label }) => (
                    <button
                      key={view}
                      type="button"
                      className={styles.addMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setShowAddMenu(false);
                        onAddWidget({ type: "agenda", view });
                      }}
                    >
                      {label}
                    </button>
                  ))}
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
      {isTransitioning ? (
        <EndOfDayTransition
          onCovered={() => navigate("/end-of-day", { state: END_OF_DAY_FADE_STATE })}
        />
      ) : null}
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
          {isEditing ? null : (
            <button
              type="button"
              className={styles.endOfDayButton}
              onClick={handleNavigateToEndOfDay}
              aria-label="Fin de journée"
            >
              <span className={styles.endOfDayIcon} aria-hidden="true">
                🌙
              </span>
              <span>Fin de journée</span>
            </button>
          )}
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
                  {AGENDA_MENU_ITEMS.map(({ view, label }) => (
                    <button
                      key={view}
                      type="button"
                      className={styles.addMenuItem}
                      role="menuitem"
                      onClick={() => {
                        setShowAddMenu(false);
                        onAddWidget({ type: "agenda", view });
                      }}
                    >
                      {label}
                    </button>
                  ))}
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
        {dragFree
          ? (() => {
              const activeId = dragFree?.id;
              const dragged = widgets.find((widget) => widget.id === activeId)?.layout;
              return dragged ? (
                <div
                  className={styles.dropSlot}
                  data-flip-id="drop-slot"
                  aria-hidden="true"
                  style={
                    {
                      "--card-column": `${dragged.x + 1} / span ${dragged.w}`,
                      "--card-row": `${dragged.y + 1} / span ${dragged.h}`,
                    } as CSSProperties
                  }
                />
              ) : null;
            })()
          : null}
        {widgets.map((widget) => {
          const view = config.views.find((candidate) => candidate.id === widget.viewId);
          const free = dragFree?.id === widget.id ? dragFree : null;
          const isDragging = free !== null;
          const isResizing = resizingId === widget.id || preview?.id === widget.id;
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
              data-flip-id={widget.id}
              tabIndex={isEditing && onMoveWidget ? 0 : undefined}
              onPointerDown={isEditing ? (event) => startDrag(event, widget) : undefined}
              onKeyDown={isEditing ? (event) => moveWithKeyboard(event, widget) : undefined}
              style={
                {
                  "--card-column": `${widget.layout.x + 1} / span ${widget.layout.w}`,
                  "--card-row": `${widget.layout.y + 1} / span ${widget.layout.h}`,
                  ...(free
                    ? {
                        transform: `translate3d(${free.left - widget.layout.x * free.stepX}px, ${free.top - widget.layout.y * free.stepY}px, 0) scale(1.02)`,
                      }
                    : {}),
                } as CSSProperties
              }
            >
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
                <CalendarWidget
                  placement={widget}
                  view={view}
                  logicalDate={logicalDate}
                  locale={config.locale}
                />
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
                <button
                  type="button"
                  className={styles.resizeHandle}
                  aria-label={`Redimensionner ${widget.title ?? MODULE_LABEL[widget.module]}`}
                  title="Glisser pour redimensionner (ou flèches du clavier)"
                  onPointerDown={(event) => startResize(event, widget)}
                  onKeyDown={(event) => resizeWithKeyboard(event, widget)}
                />
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
