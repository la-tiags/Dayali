import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getIpc } from "./ipc";
import { isHexColor } from "./theme";

/**
 * « Suivre la couleur d'accent du système ».
 *
 * C'est une préférence de **machine** (l'accent système diffère d'un Mac à
 * l'autre), donc elle vit dans le stockage local et non dans `config.json` :
 * le vault garde la couleur explicite choisie dans les pastilles.
 */
const FOLLOW_KEY = "dayali.appearance.followSystemAccent";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readFollow(): boolean {
  try {
    return window.localStorage.getItem(FOLLOW_KEY) === "1";
  } catch {
    return false;
  }
}

export function setFollowSystemAccent(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(FOLLOW_KEY, "1");
    else window.localStorage.removeItem(FOLLOW_KEY);
  } catch {
    // Stockage indisponible : la préférence ne sera pas conservée, rien de plus.
  }
  for (const listener of listeners) listener();
}

export function useFollowSystemAccent(): boolean {
  return useSyncExternalStore(subscribe, readFollow, () => false);
}

/**
 * Couleur d'accent du système, relue quand la fenêtre reprend le focus : changer
 * l'accent dans Réglages Système met l'app à jour sans redémarrage.
 * `null` quand la plateforme ne l'expose pas (ou pendant la première lecture).
 */
export function useSystemAccentColor(): string | null {
  const [color, setColor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const value = await getIpc().systemAccentColor();
      setColor(value && isHexColor(value) ? value.toLowerCase() : null);
    } catch {
      setColor(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return color;
}
