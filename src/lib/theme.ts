/**
 * Apparence de Dayali.
 *
 * La palette (fonds bruns, textes crème) vit dans `src/styles/tokens.css` : elle
 * ne bouge pas. Ce module ne gère que ce que l'utilisateur choisit dans
 * `config.json` : `appearance.theme` (auto / clair / sombre) et
 * `appearance.accentColor` (couleur d'accent, format `#rrggbb`).
 */

export type ThemeChoice = "auto" | "light" | "dark";

export const THEME_OPTIONS: readonly { readonly value: ThemeChoice; readonly label: string }[] = [
  { value: "auto", label: "Automatique" },
  { value: "light", label: "Clair" },
  { value: "dark", label: "Sombre" },
];

export interface AccentPreset {
  readonly id: string;
  readonly label: string;
  /** Couleur exacte écrite dans `appearance.accentColor`. */
  readonly accent: string;
}

/** Accent d'origine : sert aussi de repli si la config est absente ou invalide. */
export const DEFAULT_ACCENT = "#e08a52";

export interface AccentGroup {
  readonly id: string;
  readonly label: string;
  readonly presets: readonly AccentPreset[];
}

/**
 * Accents proposés dans les Réglages, en deux familles :
 * — « Tons Dayali » : la palette chaude du produit, dont Braise est le défaut ;
 * — « Couleurs du système » : les accents de macOS (Réglages Système →
 *   Apparence), pour retrouver la couleur du reste du bureau.
 * Chaque valeur reste ≥ 4,5:1 en thème sombre sur `--color-bg`, et en thème
 * clair après dérivation dans `tokens.css`.
 */
export const ACCENT_GROUPS: readonly AccentGroup[] = [
  {
    id: "dayali",
    label: "Tons Dayali",
    presets: [
      { id: "braise", label: "Braise", accent: DEFAULT_ACCENT },
      { id: "cuivre", label: "Cuivre", accent: "#c2703d" },
      { id: "ambre", label: "Ambre", accent: "#d9a441" },
      { id: "terracotta", label: "Terre cuite", accent: "#c46a5a" },
      { id: "sauge", label: "Sauge", accent: "#9fae7a" },
    ],
  },
  {
    id: "system",
    label: "Couleurs du système",
    presets: [
      { id: "sys-blue", label: "Bleu", accent: "#0a84ff" },
      { id: "sys-purple", label: "Mauve", accent: "#bf5af2" },
      { id: "sys-pink", label: "Rose", accent: "#ff6482" },
      { id: "sys-red", label: "Rouge", accent: "#ff453a" },
      { id: "sys-orange", label: "Orange", accent: "#ff9f0a" },
      { id: "sys-yellow", label: "Jaune", accent: "#ffd60a" },
      { id: "sys-green", label: "Vert", accent: "#30d158" },
      { id: "sys-graphite", label: "Graphite", accent: "#8e8e93" },
    ],
  },
];

/** Liste à plat, pratique pour retrouver un accent sans parcourir les groupes. */
export const ACCENT_PRESETS: readonly AccentPreset[] = ACCENT_GROUPS.flatMap(
  (group) => group.presets,
);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** Ramène une couleur de config à un accent utilisable, sans jamais planter. */
export function normalizeAccent(value: string | null | undefined): string {
  return value && HEX_COLOR.test(value) ? value.toLowerCase() : DEFAULT_ACCENT;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "auto" || value === "light" || value === "dark";
}

/**
 * Applique l'apparence au document.
 *
 * `auto` retire `data-scheme` : le CSS reprend la main via
 * `prefers-color-scheme`, donc aucun flash au démarrage et le choix de macOS
 * est suivi en direct (y compris pendant que l'app tourne).
 */
export function applyAppearance(
  root: HTMLElement,
  appearance: {
    readonly theme?: string | undefined;
    readonly accentColor?: string | undefined;
  } = {},
): void {
  if (appearance.theme === "light" || appearance.theme === "dark") {
    root.setAttribute("data-scheme", appearance.theme);
  } else {
    root.removeAttribute("data-scheme");
  }
  root.style.setProperty("--accent-base", normalizeAccent(appearance.accentColor));
}
