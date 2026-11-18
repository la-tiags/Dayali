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
import type { Config, WidgetPlacement } from "../../lib/contracts/types";
import { GRID_COLUMNS, healLayout, resizeLayout, resolveLayout } from "../../lib/dashboardLayout";
import { CalendarWidget } from "../widgets/CalendarWidget";
import { ReminderWidget } from "../widgets/ReminderWidget";
import styles from "./DashboardScreen.module.css";

export interface DashboardScreenProps {
  config: Config;
  logicalDate: string;
  started?: boolean;
  onBackHome: () => void;
  onOpenVaultChooser: () => void;
  busy?: boolean;
  onOpenDashboardOnLaunchChange?: (value: boolean) => void;
  onAddWidget?: (module?: "reminders" | "agenda") => void;
  onRemoveWidget?: (id: string) => void;
  onToggleWidget?: (id: string) => void;
  onMoveWidget?: (id: string, direction: "up" | "down" | "left" | "right") => void;
  onResizeWidget?: (id: string, w: number, h: number) => void | Promise<void>;
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
}: DashboardScreenProps) {
  const navigate = useNavigate();
  const rowHeight = config.dashboard.rowHeight;
  const gridRef = useRef<HTMLDivElement>(null);
  // Aperçu pendant un redimensionnement : la taille proposée n'est enregistrée qu'au relâchement.
  const [preview, setPreview] = useState<{ id: string; w: number; h: number } | null>(null);

  // Disposition affichée : une config qui se chevauche est réparée à l'affichage, et pendant
  // un redimensionnement les voisins gênés sont repoussés vers le bas en direct.
  const widgets = useMemo(() => {
    const healed = healLayout(config.dashboard.widgets);
    if (!preview) return healed;
    return resolveLayout(
      healed.map((widget) =>
        widget.id === preview.id
          ? { ...widget, layout: resizeLayout(widget.layout, preview.w, preview.h) }
          : widget,
      ),
      preview.id,
    );
  }, [config.dashboard.widgets, preview]);

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

  /** Glisser la poignée : 1 colonne = 1 cran en largeur, 1 ligne (`rowHeight`) = 1 cran en hauteur. */
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

  /** Même poignée au clavier : les flèches agrandissent ou réduisent d'un cran. */
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
            <>
              <Button variant="primary" onClick={() => onAddWidget("reminders")}>
                + Widget Rappels
              </Button>
              <Button variant="secondary" onClick={() => onAddWidget("agenda")}>
                + Widget Agenda
              </Button>
            </>
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
            <>
              <Button variant="primary" onClick={() => onAddWidget("reminders")}>
                + Widget Rappels
              </Button>
              <Button variant="secondary" onClick={() => onAddWidget("agenda")}>
                + Widget Agenda
              </Button>
            </>
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
          return (
            <section
              key={widget.id}
              className={`${styles.card} ${widget.enabled ? "" : styles.cardDisabled} ${isEditing ? styles.cardEditing : ""} ${preview?.id === widget.id ? styles.cardResizing : ""}`}
              aria-labelledby={`${widget.id}-title`}
              style={
                {
                  "--card-column": `${widget.layout.x + 1} / span ${widget.layout.w}`,
                  "--card-row": `${widget.layout.y + 1} / span ${widget.layout.h}`,
                } as CSSProperties
              }
            >
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle} id={`${widget.id}-title`}>
                  {widget.title ?? MODULE_LABEL[widget.module]}
                </h2>
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
                  {preview?.id === widget.id ? (
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
                  {onMoveWidget ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Monter ${widget.title ?? MODULE_LABEL[widget.module]}`}
                        onClick={() => onMoveWidget(widget.id, "up")}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Descendre ${widget.title ?? MODULE_LABEL[widget.module]}`}
                        onClick={() => onMoveWidget(widget.id, "down")}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Décaler à gauche ${widget.title ?? MODULE_LABEL[widget.module]}`}
                        onClick={() => onMoveWidget(widget.id, "left")}
                      >
                        ←
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Décaler à droite ${widget.title ?? MODULE_LABEL[widget.module]}`}
                        onClick={() => onMoveWidget(widget.id, "right")}
                      >
                        →
                      </Button>
                    </>
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
