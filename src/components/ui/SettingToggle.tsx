import styles from "./SettingToggle.module.css";

export interface SettingToggleProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * Réglage binaire natif : `<input type="checkbox">` + libellé associé, donc
 * clavier, lecteur d'écran et focus natifs (aucun `div` cliquable).
 */
export function SettingToggle({
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: SettingToggleProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {description ? (
          <p className={styles.description} id={descriptionId}>
            {description}
          </p>
        ) : null}
      </div>
      <span className={styles.control}>
        <input
          id={id}
          type="checkbox"
          className={styles.input}
          checked={checked}
          disabled={disabled}
          aria-describedby={descriptionId}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </span>
    </div>
  );
}
