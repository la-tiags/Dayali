import { useEffect } from "react";
import { getIpc } from "../../lib/ipc";
import { useAppStore } from "../../stores/app.store";

/** Délai minimal entre deux actualisations déclenchées par un changement d'écran. */
const MIN_GAP_MS = 5 * 60_000;
/** Période d'actualisation tant que l'application reste ouverte. */
const INTERVAL_MS = 30 * 60_000;

let lastRun = 0;

async function refreshFeeds(): Promise<void> {
  try {
    const feeds = await getIpc().calendarFeedList();
    if (feeds.length === 0) return;
    await getIpc().calendarFeedRefresh();
    window.dispatchEvent(new Event("dayali:feeds-updated"));
    void useAppStore.getState().reloadAgenda();
  } catch {
    // Hors ligne ou serveur indisponible : le cache précédent reste affiché.
  }
}

/**
 * Actualise en arrière-plan les calendriers abonnés par URL : au lancement (puis au plus toutes
 * les 5 minutes lors des changements d'écran) et toutes les 30 minutes. Silencieux : l'agenda
 * reste lisible hors connexion grâce au cache.
 */
export function useFeedAutoRefresh(): void {
  useEffect(() => {
    if (Date.now() - lastRun > MIN_GAP_MS) {
      lastRun = Date.now();
      void refreshFeeds();
    }
    const timer = window.setInterval(() => {
      lastRun = Date.now();
      void refreshFeeds();
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
}
