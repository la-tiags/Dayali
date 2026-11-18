import { type CSSProperties, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import type { Config, WidgetPlacement } from "../../lib/contracts/types";
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
  onResizeWidget?: (id: string, w: number, h: number) => void;
}

const MODULE_LABEL: Record<WidgetPlacement["module"], string> = {
  agenda: "Agenda",
  reminders: "Rappels",
  journal: "Journal",
  projects: "Projets",
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
  const widgets = config.dashboard.widgets;
  const rowHeight = config.dashboard.rowHeight;

  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const showBanner = started === false && !bannerDismissed;

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

      <div className={styles.grid} style={{ gridAutoRows: `${rowHeight}px` }}>
        {widgets.map((widget) => {
          const view = config.views.find((candidate) => candidate.id === widget.viewId);
          return (
            <section
              key={widget.id}
              className={`${styles.card} ${widget.enabled ? "" : styles.cardDisabled} ${isEditing ? styles.cardEditing : ""}`}
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
                        onClick={() => onMoveWidget(widget.id, "up")}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onMoveWidget(widget.id, "down")}
                      >
                        ↓
                      </Button>
                    </>
                  ) : null}
                  {onResizeWidget ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        onResizeWidget(widget.id, widget.layout.w, widget.layout.h + 1)
                      }
                    >
                      +
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
