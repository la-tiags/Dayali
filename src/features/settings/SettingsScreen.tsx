import { useId } from "react";
import { Button } from "../../components/ui/Button";
import { SettingToggle } from "../../components/ui/SettingToggle";
import {
  ACCENT_GROUPS,
  DEFAULT_ACCENT,
  normalizeAccent,
  THEME_OPTIONS,
  type ThemeChoice,
} from "../../lib/theme";
import { UpdatesPanel } from "../updates/UpdatesPanel";
import { CalendarFeedsPanel } from "./CalendarFeedsPanel";
import styles from "./SettingsScreen.module.css";

export interface SettingsScreenProps {
  vaultName: string;
  vaultPath: string;
  openDashboardOnLaunch: boolean;
  theme?: ThemeChoice;
  accentColor?: string;
  /** L'accent vient de Réglages Système plutôt que d'une pastille. */
  followSystemAccent?: boolean;
  /** Accent du système lu sur la machine, `null` si indisponible. */
  systemAccentColor?: string | null;
  busy?: boolean;
  onOpenDashboardOnLaunchChange?: (value: boolean) => void;
  onThemeChange?: (value: ThemeChoice) => void;
  onAccentColorChange?: (value: string) => void;
  onFollowSystemAccentChange?: (value: boolean) => void;
  onOpenVaultChooser?: () => void;
  version?: string;
}

export function SettingsScreen({
  vaultName,
  vaultPath,
  openDashboardOnLaunch,
  theme = "auto",
  accentColor = DEFAULT_ACCENT,
  followSystemAccent = false,
  systemAccentColor = null,
  busy = false,
  onOpenDashboardOnLaunchChange,
  onThemeChange,
  onAccentColorChange,
  onFollowSystemAccentChange,
  onOpenVaultChooser,
  version = "0.1.0",
}: SettingsScreenProps) {
  const titleId = useId();
  const vaultSectionId = useId();
  const prefsSectionId = useId();
  const appearanceSectionId = useId();
  const followSystemId = useId();
  const currentAccent = normalizeAccent(accentColor);
  const calendarsSectionId = useId();
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

      <section className={styles.card} aria-labelledby={appearanceSectionId}>
        <h2 className={styles.sectionTitle} id={appearanceSectionId}>
          Apparence
        </h2>
        <fieldset className={styles.appearanceGroup}>
          <legend className={styles.groupLegend}>Thème</legend>
          <div className={styles.choiceRow}>
            {THEME_OPTIONS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={theme === option.value ? "primary" : "secondary"}
                aria-pressed={theme === option.value}
                disabled={busy || !onThemeChange}
                onClick={() => onThemeChange?.(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className={styles.hint}>« Automatique » suit l'apparence de macOS.</p>
        </fieldset>
        {ACCENT_GROUPS.map((group) => (
          <fieldset className={styles.appearanceGroup} key={group.id}>
            <legend className={styles.groupLegend}>{group.label}</legend>
            <div className={styles.swatchGrid}>
              {group.presets.map((preset) => {
                const selected = !followSystemAccent && currentAccent === preset.accent;
                return (
                  <Button
                    key={preset.id}
                    size="sm"
                    variant={selected ? "primary" : "secondary"}
                    aria-pressed={selected}
                    disabled={busy || followSystemAccent || !onAccentColorChange}
                    onClick={() => onAccentColorChange?.(preset.accent)}
                  >
                    <span
                      className={styles.swatch}
                      style={{ backgroundColor: preset.accent }}
                      aria-hidden="true"
                    />
                    {preset.label}
                  </Button>
                );
              })}
            </div>
          </fieldset>
        ))}
        <p className={styles.hint}>
          Le fond chaud ne change pas ; seules les touches d'accent varient.
        </p>
        <SettingToggle
          id={followSystemId}
          label="Suivre la couleur du système"
          description={
            systemAccentColor
              ? `Utiliser l'accent de Réglages Système (${systemAccentColor}) à la place d'une pastille.`
              : "Indisponible sur cette plateforme : choisis une pastille."
          }
          checked={followSystemAccent}
          disabled={busy || !systemAccentColor || !onFollowSystemAccentChange}
          onChange={(value) => onFollowSystemAccentChange?.(value)}
        />
      </section>

      <section className={styles.card} aria-labelledby={calendarsSectionId}>
        <h2 className={styles.sectionTitle} id={calendarsSectionId}>
          Calendriers en ligne
        </h2>
        <CalendarFeedsPanel />
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
