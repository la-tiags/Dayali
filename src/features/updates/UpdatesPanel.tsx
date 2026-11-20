import { Button } from "../../components/ui/Button";
import { useUpdaterStore } from "../../stores/updater.store";
import { downloadPercent, formatBytes } from "./format";
import styles from "./UpdatesPanel.module.css";

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Contenu de la section « Mises à jour » des Réglages (la carte et le titre sont dans l'écran). */
export function UpdatesPanel() {
  const status = useUpdaterStore((state) => state.status);
  const supported = useUpdaterStore((state) => state.supported);
  const currentVersion = useUpdaterStore((state) => state.currentVersion);
  const checkForUpdates = useUpdaterStore((state) => state.checkForUpdates);
  const installUpdate = useUpdaterStore((state) => state.installUpdate);

  const busy =
    status.phase === "checking" || status.phase === "downloading" || status.phase === "restarting";
  const version = currentVersion ?? "inconnue";

  let message: string;
  switch (status.phase) {
    case "checking":
      message = "Recherche d'une nouvelle version…";
      break;
    case "upToDate":
      message = `Dayali est à jour (version ${version}). Dernière vérification à ${timeLabel(status.checkedAt)}.`;
      break;
    case "available":
      message = `La version ${status.update.version} est disponible (vous avez la ${status.update.currentVersion}).`;
      break;
    case "downloading":
      message = `Téléchargement de la version ${status.update.version}…`;
      break;
    case "restarting":
      message = "Mise à jour installée : redémarrage de Dayali…";
      break;
    case "error":
      message = status.message;
      break;
    default:
      message = supported
        ? `Version installée : ${version}. Dayali vérifie automatiquement les nouvelles versions au démarrage.`
        : "Les mises à jour automatiques ne sont disponibles que dans l'application installée.";
  }

  const update =
    status.phase === "available" || status.phase === "downloading" || status.phase === "restarting"
      ? status.update
      : status.phase === "error"
        ? status.update
        : null;
  const percent =
    status.phase === "downloading" ? downloadPercent(status.downloaded, status.total) : null;
  const canInstall = status.phase === "available" || (status.phase === "error" && status.update);

  return (
    <div className={styles.panel}>
      <p className={styles.message} role={status.phase === "error" ? "alert" : "status"}>
        {message}
      </p>

      {status.phase === "downloading" ? (
        <div className={styles.progressBlock}>
          <progress
            className={styles.progress}
            aria-label="Progression du téléchargement"
            value={percent ?? undefined}
            max={100}
          />
          <span className={styles.progressText}>
            {percent !== null ? `${percent} %` : formatBytes(status.downloaded)}
          </span>
        </div>
      ) : null}

      {update?.notes ? (
        <details className={styles.notes}>
          <summary>Notes de version {update.version}</summary>
          <p className={styles.notesBody}>{update.notes}</p>
        </details>
      ) : null}

      <div className={styles.actions}>
        {canInstall ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void installUpdate()}>
            {status.phase === "error" ? "Réessayer l'installation" : "Installer et redémarrer"}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={!supported || busy}
          onClick={() => void checkForUpdates()}
        >
          {status.phase === "checking" ? "Recherche…" : "Rechercher des mises à jour"}
        </Button>
      </div>
    </div>
  );
}
