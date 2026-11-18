import { type DayaliError, userMessage } from "../../lib/ipc/errors";
import { Button } from "./Button";
import styles from "./StatusBanners.module.css";

export interface StatusBannersProps {
  error: DayaliError | null;
  /** Copie `.conflict-*` signalée par Rust : jamais masquable. */
  conflictCopy: string | null;
  timeZoneWarning?: string | null;
  reloading?: boolean;
  onReloadConfig: () => void;
  onDismissError: () => void;
}

/**
 * Bandeaux d'état : erreur IPC, conflit de configuration, fuseau inconnu.
 * Un conflit ne peut pas être fermé (SPEC §1.6 : jamais trompeur).
 */
export function StatusBanners({
  error,
  conflictCopy,
  timeZoneWarning = null,
  reloading = false,
  onReloadConfig,
  onDismissError,
}: StatusBannersProps) {
  const conflictVisible = Boolean(error && error.code === "E_CONFLICT");
  const canDismiss = Boolean(error) && !conflictVisible;
  const canReload =
    Boolean(error) &&
    (error?.code === "E_PRECONDITION_FAILED" ||
      error?.code === "E_SCHEMA_INVALID" ||
      error?.retryable === true);

  return (
    <div className={styles.stack}>
      {error ? (
        <div className={styles.banner} role="alert">
          <div className={styles.body}>
            <p className={styles.title}>{userMessage(error)}</p>
            <p className={styles.code}>{error.code}</p>
            {canReload ? (
              <p className={styles.detail}>
                Aucune écriture n'a été faite. Rechargez pour repartir de l'état actuel du vault.
              </p>
            ) : null}
          </div>
          <div className={styles.actions}>
            {canReload ? (
              <Button size="sm" variant="secondary" onClick={onReloadConfig} disabled={reloading}>
                Recharger
              </Button>
            ) : null}
            {canDismiss ? (
              <Button size="sm" variant="ghost" onClick={onDismissError}>
                Fermer
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {conflictCopy ? (
        <div className={styles.banner} role="status">
          <div className={styles.body}>
            <p className={styles.title}>Copie de conflit conservée</p>
            <p className={styles.detail}>
              <code>{conflictCopy}</code> — votre configuration a été modifiée sur une autre
              machine. Rien n'a été écrasé ; la copie reste dans le vault jusqu'à votre choix.
            </p>
          </div>
        </div>
      ) : null}

      {timeZoneWarning ? (
        <div className={styles.banner} role="status">
          <div className={styles.body}>
            <p className={styles.title}>Fuseau horaire</p>
            <p className={styles.detail}>{timeZoneWarning}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
