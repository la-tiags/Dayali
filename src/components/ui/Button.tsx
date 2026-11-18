import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

const VARIANT_CLASS: Record<Variant, string> = {
  primary: styles.primary ?? "",
  secondary: styles.secondary ?? "",
  ghost: styles.ghost ?? "",
};

const SIZE_CLASS: Record<Size, string> = {
  sm: styles.sm ?? "",
  md: styles.md ?? "",
  lg: styles.lg ?? "",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  children: ReactNode;
}

/** Bouton de base : `type="button"` par défaut (aucune soumission implicite). */
export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    VARIANT_CLASS[variant],
    SIZE_CLASS[size],
    block ? styles.block : null,
    className,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
