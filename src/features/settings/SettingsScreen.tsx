import { useId } from "react";
import { Button } from "../../components/ui/Button";
import { SettingToggle } from "../../components/ui/SettingToggle";
import { UpdatesPanel } from "../updates/UpdatesPanel";
import styles from "./SettingsScreen.module.css";

export interface SettingsScreenProps {
  vaultName: string;
  vaultPath: string;
  openDashboardOnLaunch: boolean;
  busy?: boolean;
  onOpenDashboardOnLaunchChange?: (value: boolean) => void;
  onOpenVaultChooser?: () => void;
  version?: string;
}

export function SettingsScreen({
  vaultName,
  vaultPath,
  openDashboardOnLaunch,
  busy = false,
  onOpenDashboardOnLaunchChange,
  onOpenVaultChooser,
  version = "0.1.0",
}: SettingsScreenProps) {
  const titleId = useId();
  const vaultSectionId = useId();
  const prefsSectionId = useId();
  const updatesSectionId = useId();
  const aboutSectionId = useId();
  const launchToggleId = useId();

  return (
    <section className={styles.screen} aria-labelledby={titleId}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title} id={titleId}>
            Réglages
          </h1>
          <p className={styles.meta}>Configuration de l'application et gestion du vault actif.</p>
        </div>
      </header>

      <section className={styles.card} aria-labelledby={vaultSectionId}>
        <h2 className={styles.sectionTitle} id={vaultSectionId}>
          Vault actuel
        </h2>
        <div className={styles.vaultDetails}>
          <div className={styles.vaultInfo}>
            <p className={styles.vaultNameLabel}>
              Nom : <strong>{vaultName}</strong>
            </p>
            <p className={styles.vaultPathLabel}>
              Chemin : <code className={styles.code}>{vaultPath}</code>
            </p>
          </div>
          <div className={styles.vaultActions}>
            <Button size="sm" variant="secondary" onClick={onOpenVaultChooser} disabled={busy}>
              Changer de vault
            </Button>
          </div>
        </div>
      </section>

      <section className={styles.card} aria-labelledby={prefsSectionId}>
        <h2 className={styles.sectionTitle} id={prefsSectionId}>
          Préférences de l'application
        </h2>
        <SettingToggle
          id={launchToggleId}
          label="Ouvrir directement le dashboard"
          description="Au lancement, afficher le dashboard même si la journée n'a pas encore démarré sur cette machine."
          checked={openDashboardOnLaunch}
          disabled={busy || !onOpenDashboardOnLaunchChange}
          onChange={(value) => onOpenDashboardOnLaunchChange?.(value)}
        />
      </section>

      <section className={styles.card} aria-labelledby={updatesSectionId}>
        <h2 className={styles.sectionTitle} id={updatesSectionId}>
          Mises à jour
        </h2>
        <UpdatesPanel />
      </section>

      <section className={styles.card} aria-labelledby={aboutSectionId}>
        <h2 className={styles.sectionTitle} id={aboutSectionId}>
          Informations et crédits
        </h2>
        <div className={styles.aboutContent}>
          <p className={styles.versionText}>Dayali — Version {version}</p>
          <p className={styles.legalText}>
            Poste de pilotage personnel. Tous les fichiers vivent dans votre vault local.
          </p>
          <div className={styles.creditsBlock} data-testid="settings-credits">
            <h3 className={styles.creditsTitle}>Crédits et licences</h3>
            <ul className={styles.creditsList}>
              <li>Police Lora : SIL Open Font License 1.1 (OFL)</li>
              <li>
                Photos d'accueil (mode bundlé) : Salvatore Gerace, Romain Guy, David Marcu, Agnes
                Monkelbaan — CC0 1.0 Universal
              </li>
            </ul>
          </div>
        </div>
      </section>
    </section>
  );
}
