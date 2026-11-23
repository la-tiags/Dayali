import { useEffect } from "react";
import { useFollowSystemAccent, useSystemAccentColor } from "@/lib/system-accent";
import { applyAppearance } from "@/lib/theme";
import { useAppStore } from "@/stores/app.store";

/**
 * Applique `appearance.theme` et l'accent à `<html>`, à chaque rechargement de la
 * config (donc après une modification dans les Réglages). Si l'utilisateur suit
 * la couleur du système, l'accent lu sur la machine prend le pas sur
 * `appearance.accentColor`, qui reste mémorisé pour le retour en arrière.
 */
export function AppearanceSync() {
  const theme = useAppStore((state) => state.config?.appearance.theme);
  const accentColor = useAppStore((state) => state.config?.appearance.accentColor);
  const followSystem = useFollowSystemAccent();
  const systemAccent = useSystemAccentColor();

  const accent = followSystem && systemAccent ? systemAccent : accentColor;

  useEffect(() => {
    applyAppearance(document.documentElement, { theme, accentColor: accent });
  }, [theme, accent]);

  return null;
}
