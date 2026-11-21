import { type MouseEvent, type ReactNode, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { SkipLink } from "../ui/SkipLink";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  vaultName: string;
  banners?: ReactNode;
  onOpenVaultChooser: () => void;
  children: ReactNode;
}

/** Coquille des écrans vault ouvert : sidebar latérale responsive, navigation clavier, bandeaux persistants. */
export function AppShell({ vaultName, banners, onOpenVaultChooser, children }: AppShellProps) {
  const navigate = useNavigate();
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handleGoEndOfDay = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setIsTransitioning(true);
    setTimeout(() => {
      navigate("/end-of-day");
    }, 220);
  };

  return (
    <div className={styles.shell}>
      {isTransitioning ? (
        <div className={styles.fullscreenTransitionOverlay} aria-hidden="true" />
      ) : null}
      <SkipLink />
      <aside className={styles.sidebar} aria-label="Navigation principale et vault">
        <div className={styles.topSection}>
          <NavLink
            to="/today"
            state={{ reviewHome: true }}
            className={({ isActive }) =>
              [styles.backHomeLink, isActive ? styles.active : ""].filter(Boolean).join(" ")
            }
            aria-label="Démarrage de journée"
          >
            <span className={styles.backArrow} aria-hidden="true">
              ←
            </span>
            <span className={styles.backLabel}>Démarrage de journée</span>
          </NavLink>
          {vaultName !== "Dayali" && (
            <div className={styles.vaultInfo}>
              <span className={styles.vaultName} title={vaultName}>
                {vaultName}
              </span>
              <button
                type="button"
                className={styles.vaultChangeBtn}
                onClick={onOpenVaultChooser}
                title="Changer de vault"
                aria-label="Changer de vault"
              >
                <svg
                  className={styles.icon}
                  aria-hidden="true"
                  focusable="false"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 19V6c0-1.1.9-2 2-2h6l2 2h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
                </svg>
                <span className={styles.vaultChangeLabel}>Changer</span>
              </button>
            </div>
          )}
        </div>

        <nav className={styles.nav} aria-label="Modules Dayali">
          <NavLink to="/dashboard" className={styles.navLink ?? ""} aria-label="Dashboard">
            <svg
              className={styles.navIcon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="7" height="9" />
              <rect x="14" y="3" width="7" height="5" />
              <rect x="14" y="12" width="7" height="9" />
              <rect x="3" y="16" width="7" height="5" />
            </svg>
            <span className={styles.navText}>Dashboard</span>
          </NavLink>
          <NavLink to="/calendar" className={styles.navLink ?? ""} aria-label="Agenda">
            <svg
              className={styles.navIcon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span className={styles.navText}>Agenda</span>
          </NavLink>
          <NavLink to="/reminders" className={styles.navLink ?? ""} aria-label="Rappels">
            <svg
              className={styles.navIcon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            <span className={styles.navText}>Rappels</span>
          </NavLink>
        </nav>

        <div className={styles.footer}>
          <NavLink
            to="/end-of-day"
            onClick={handleGoEndOfDay}
            className={({ isActive }) =>
              [styles.endOfDayLink, isActive ? styles.active : ""].filter(Boolean).join(" ")
            }
            aria-label="Fin de journée"
          >
            <svg
              className={styles.navIcon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <span className={styles.navText}>Fin de journée</span>
          </NavLink>
          <NavLink to="/settings" className={styles.navLink ?? ""} aria-label="Réglages">
            <svg
              className={styles.navIcon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className={styles.navText}>Réglages</span>
          </NavLink>
        </div>
      </aside>
      <div className={styles.contentArea}>
        {banners ? <div className={styles.banners}>{banners}</div> : null}
        <main className={styles.main} id="contenu" tabIndex={-1}>
          <div className={styles.content}>{children}</div>
        </main>
      </div>
    </div>
  );
}
