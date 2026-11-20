import { Button } from "../../components/ui/Button";
import { useUpdaterStore } from "../../stores/updater.store";
import { downloadPercent } from "./format";
import styles from "./UpdateToast.module.css";

/**
 * Notification discrète, visible sur tous les écrans, quand une nouvelle version est disponible.
 * Elle ne s'installe jamais toute seule : « Plus tard » la masque pour cette version.
 */
export function UpdateToast() {
  const status = useUpdaterStore((state) => state.status);
  const dismissedVersion = useUpdaterStore((state) => state.dismissedVersion);
  const installUpdate = useUpdaterStore((state) => state.installUpdate);
  const dismissNotification = useUpdaterStore((state) => state.dismissNotification);

  if (status.phase === "downloading") {
    const percent = downloadPercent(status.downloaded, status.total);
    return (
      <aside className={styles.toast} role="status" aria-live="polite">
        <p className={styles.title}>Téléchargement de Dayali {status.update.version}…</p>
        <progress
          className={styles.progress}
          aria-label="Progression du téléchargement"
          value={percent ?? undefined}
          max={100}
        />
      </aside>
    );
  }

  if (status.phase === "restarting") {
    return (
      <aside className={styles.toast} role="status" aria-live="polite">
        <p className={styles.title}>Mise à jour installée, redémarrage…</p>
      </aside>
    );
  }

  const notifiable =
    status.phase === "available" || status.phase === "error" ? status.update : null;
  if (notifiable && notifiable.version !== dismissedVersion) {
    const failed = status.phase === "error";
    return (
      <aside className={styles.toast} role={failed ? "alert" : "status"} aria-live="polite">
        <p className={styles.title}>
          {status.phase === "error"
            ? status.message
            : `Dayali ${notifiable.version} est disponible`}
        </p>
        <div className={styles.actions}>
          <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
            {failed ? "Réessayer" : "Installer et redémarrer"}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissNotification}>
            {failed ? "Fermer" : "Plus tard"}
          </Button>
        </div>
      </aside>
    );
  }

  return null;
}
