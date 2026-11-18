import type { FormEvent } from "react";
import { useId, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { DirectoryPicker } from "../../lib/ipc/dialog";
import { baseName, joinPath, validateVaultName } from "../../lib/paths";
import styles from "./VaultSetupScreen.module.css";

export interface VaultSetupScreenProps {
  recentVaults: readonly string[];
  lastVaultPath: string | null;
  busy: boolean;
  error: string | null;
  errorCode?: string | null;
  /** Détails de l'erreur IPC (ex. `{ reason: "not_empty" }`). */
  errorDetails?: Record<string, unknown> | null;
  pickDirectory: DirectoryPicker;
  onOpenVault: (path: string) => void;
  onCreateVault: (parentPath: string, name: string) => void;
  onDismissError: () => void;
}

type SetupView = "home" | "wizard";
type WizardStep = 1 | 2 | 3;
type PickingPurpose = "vault" | "parent" | null;

export function VaultSetupScreen({
  recentVaults,
  lastVaultPath,
  busy,
  error,
  errorCode = null,
  errorDetails = null,
  pickDirectory,
  onOpenVault,
  onCreateVault,
  onDismissError,
}: VaultSetupScreenProps) {
  const [view, setView] = useState<SetupView>("home");
  const [step, setStep] = useState<WizardStep>(1);
  const [parentPath, setParentPath] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [picking, setPicking] = useState<PickingPurpose>(null);
  const [attempt, setAttempt] = useState<{ parentPath: string; name: string } | null>(null);

  const parentId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();

  const isBusy = busy || picking !== null;
  const nameError = nameTouched ? validateVaultName(name) : null;
  const previewPath = parentPath ? joinPath(parentPath, name || "…") : null;

  const existingTarget =
    errorCode === "E_PRECONDITION_FAILED" &&
    errorDetails?.reason === "not_empty" &&
    attempt !== null &&
    validateVaultName(attempt.name) === null
      ? joinPath(attempt.parentPath, attempt.name)
      : null;

  const openExisting = async () => {
    setPickerError(null);
    setPicking("vault");
    try {
      const picked = await pickDirectory({
        purpose: "vault",
        title: "Choisir le dossier du vault",
      });
      if (picked) onOpenVault(picked);
    } catch {
      setPickerError("Le sélecteur de dossier n'a pas pu s'ouvrir. Réessayez.");
    } finally {
      setPicking(null);
    }
  };

  const pickParent = async () => {
    setPickerError(null);
    setPicking("parent");
    try {
      const picked = await pickDirectory({
        purpose: "parent",
        title: "Choisir le dossier parent du vault",
      });
      if (picked) setParentPath(picked);
    } catch {
      setPickerError("Le sélecteur de dossier n'a pas pu s'ouvrir. Réessayez.");
    } finally {
      setPicking(null);
    }
  };

  const handleNextStep = (event: FormEvent) => {
    event.preventDefault();
    if (step === 1) {
      const invalid = validateVaultName(name);
      if (invalid) {
        setNameTouched(true);
        return;
      }
      setNameTouched(false);
      setFormError(null);
      setStep(2);
    } else if (step === 2) {
      if (!parentPath) {
        setFormError("Choisissez d'abord le dossier parent du vault.");
        return;
      }
      setFormError(null);
      setStep(3);
    }
  };

  const submitCreate = () => {
    if (!parentPath) {
      setFormError("Choisissez d'abord le dossier parent du vault.");
      setStep(2);
      return;
    }
    const invalid = validateVaultName(name);
    if (invalid) {
      setNameTouched(true);
      setStep(1);
      return;
    }
    setFormError(null);
    setAttempt({ parentPath, name });
    onCreateVault(parentPath, name);
  };

  const startCreation = () => {
    setView("wizard");
    setStep(1);
    setName("");
    setNameTouched(false);
    setParentPath("");
    setFormError(null);
  };

  return (
    <div className={styles.screen} data-testid="vault-setup-screen">
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <main className={styles.shell} id="contenu">
        <header className={styles.hero}>
          <p className={styles.brand}>Dayali</p>
          <h1 className={styles.title}>
            {view === "home" ? "Votre journée, vos fichiers, chez vous." : "Créer un nouveau vault"}
          </h1>
          <p className={styles.lead}>
            {view === "home"
              ? "Ouvrez un dossier existant pour en faire un vault, ou créez-en un nouveau. Tout reste en fichiers ouverts sur votre disque : rien n'est envoyé ailleurs."
              : `Étape ${step} sur 3 : ${
                  step === 1
                    ? "Nommer votre vault"
                    : step === 2
                      ? "Choisir l'emplacement"
                      : "Confirmation"
                }`}
          </p>
        </header>

        {error ? (
          <div className={styles.alert} role="alert">
            <p>{error}</p>
            {errorCode ? <code className={styles.alertCode}>{errorCode}</code> : null}
            {existingTarget ? (
              <p className={styles.alertHint}>
                Aucune donnée n'a été écrasée. Ce dossier peut être ouvert tel quel :{" "}
                <code>{existingTarget}</code>. Utilisez « Ouvrir ce dossier », ou choisissez un
                autre nom.
              </p>
            ) : null}
            <div className={styles.formActions}>
              {existingTarget ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onOpenVault(existingTarget)}
                  disabled={isBusy}
                >
                  Ouvrir ce dossier
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={onDismissError}>
                Fermer
              </Button>
            </div>
          </div>
        ) : null}

        {pickerError ? (
          <p className={styles.pickerError} role="status">
            {pickerError}
          </p>
        ) : null}

        {view === "home" ? (
          <>
            <section className={styles.section} aria-labelledby="vaults-recents">
              <h2 className={styles.sectionTitle} id="vaults-recents">
                Vaults récents
              </h2>
              {recentVaults.length > 0 ? (
                <ul className={styles.recentList}>
                  {recentVaults.map((path) => {
                    const isLast = path === lastVaultPath;
                    return (
                      <li key={path}>
                        <button
                          type="button"
                          className={styles.recentButton}
                          onClick={() => onOpenVault(path)}
                          disabled={isBusy}
                        >
                          <span className={styles.recentName}>{baseName(path)}</span>
                          <span className={styles.recentPath}>{path}</span>
                          {isLast ? <span className={styles.badge}>Dernier ouvert</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className={styles.empty}>
                  Aucun vault récent. Ouvrez un dossier ou créez un vault pour commencer.
                </p>
              )}
            </section>

            <section className={styles.actionsSection} aria-labelledby="vault-actions">
              <h2 className={styles.sectionTitle} id="vault-actions">
                Actions
              </h2>
              <div className={styles.actions}>
                <Button variant="primary" onClick={startCreation} disabled={isBusy}>
                  Créer un nouveau vault
                </Button>
                <Button variant="secondary" onClick={openExisting} disabled={isBusy}>
                  Ouvrir un dossier
                </Button>
              </div>
            </section>
          </>
        ) : (
          <div className={styles.wizard}>
            <div className={styles.wizardProgress} aria-hidden="true">
              <div className={`${styles.progressDot} ${step >= 1 ? styles.activeDot : ""}`} />
              <div className={`${styles.progressLine} ${step >= 2 ? styles.activeLine : ""}`} />
              <div className={`${styles.progressDot} ${step >= 2 ? styles.activeDot : ""}`} />
              <div className={`${styles.progressLine} ${step >= 3 ? styles.activeLine : ""}`} />
              <div className={`${styles.progressDot} ${step >= 3 ? styles.activeDot : ""}`} />
            </div>

            <form
              className={styles.form}
              onSubmit={
                step === 3
                  ? (e) => {
                      e.preventDefault();
                      submitCreate();
                    }
                  : handleNextStep
              }
              aria-labelledby="vault-create-title"
              aria-busy={isBusy}
              noValidate
            >
              {step === 1 && (
                <div className={styles.wizardStepContent}>
                  <h2 className={styles.stepHeaderTitle} id="vault-create-title">
                    1. Donnez un nom à votre vault
                  </h2>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor={nameId}>
                      Nom du vault
                    </label>
                    <input
                      id={nameId}
                      className={styles.textInput}
                      type="text"
                      value={name}
                      placeholder="Travail ou Personnel"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={isBusy}
                      aria-invalid={nameError ? true : undefined}
                      aria-describedby={nameError ? `${nameHintId} ${nameErrorId}` : nameHintId}
                      onChange={(event) => {
                        setName(event.target.value);
                        if (event.target.value !== "") setNameTouched(true);
                      }}
                      onBlur={() => setNameTouched(true)}
                    />
                    <p className={styles.fieldHint} id={nameHintId}>
                      Le nom du dossier à créer. Sans / \ : * ? " &lt; &gt; | et sans fin par un
                      espace ou un point.
                    </p>
                    {nameError ? (
                      <p className={styles.formError} id={nameErrorId} aria-live="polite">
                        {nameError}
                      </p>
                    ) : null}
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className={styles.wizardStepContent}>
                  <h2 className={styles.stepHeaderTitle} id="vault-create-title">
                    2. Choisissez l'emplacement (dossier parent)
                  </h2>
                  <p className={styles.fieldHint}>
                    Vous choisissez un dossier <strong>parent</strong> : l'application y créera le
                    sous-dossier <code>{name || "nom-du-vault"}</code> avec un dossier caché{" "}
                    <code>.dayali/</code> dedans.
                  </p>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel} id={parentId}>
                      Dossier parent
                    </span>
                    <div className={styles.parentRow}>
                      <span className={styles.parentPath} aria-live="polite">
                        {parentPath || "Aucun dossier parent choisi"}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={pickParent}
                        disabled={isBusy}
                        aria-describedby={parentId}
                        type="button"
                      >
                        Choisir un dossier parent
                      </Button>
                    </div>
                  </div>

                  {previewPath ? (
                    <p className={styles.fieldHint}>
                      Aperçu du chemin cible : <code>{previewPath}</code>
                    </p>
                  ) : null}

                  {formError ? (
                    <p className={styles.formError} role="alert">
                      {formError}
                    </p>
                  ) : null}
                </div>
              )}

              {step === 3 && (
                <div className={styles.wizardStepContent}>
                  <h2 className={styles.stepHeaderTitle} id="vault-create-title">
                    3. Confirmation de création
                  </h2>
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>Nom du vault :</span>
                      <strong className={styles.summaryValue}>{name}</strong>
                    </div>
                    <div className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>Dossier parent :</span>
                      <code className={styles.summaryValue}>{parentPath}</code>
                    </div>
                    <div className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>Chemin complet :</span>
                      <code className={styles.summaryValue}>{previewPath}</code>
                    </div>
                  </div>
                  <figure className={styles.treeFigure} aria-label="Exemple d'arborescence créée">
                    <pre className={styles.tree}>
                      {[
                        `${baseName(parentPath || "Documents")}/`,
                        `└── ${name}/`,
                        `    └── .dayali/`,
                      ].join("\n")}
                    </pre>
                  </figure>
                  <p className={styles.example}>
                    La création configurera le vault sur votre disque de manière totalement locale.
                  </p>

                  {formError ? (
                    <p className={styles.formError} role="alert">
                      {formError}
                    </p>
                  ) : null}
                </div>
              )}

              <div className={styles.formActions}>
                {step > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setStep((s) => (s - 1) as WizardStep)}
                    disabled={isBusy}
                  >
                    Précédent
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setView("home")}
                    disabled={isBusy}
                  >
                    Annuler
                  </Button>
                )}

                {step < 3 ? (
                  <Button type="submit" size="sm" variant="primary" disabled={isBusy}>
                    Suivant
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={isBusy}
                    onClick={submitCreate}
                  >
                    Créer le vault
                  </Button>
                )}
              </div>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
