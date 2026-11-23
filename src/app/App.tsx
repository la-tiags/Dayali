import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { AppearanceSync } from "@/app/AppearanceSync";
import { BootstrapGate } from "@/app/BootstrapGate";
import { Providers } from "@/app/providers";
import { router } from "@/app/router";
import { UpdateToast } from "@/features/updates/UpdateToast";
import { useUpdaterStore } from "@/stores/updater.store";

/** Délai avant la vérification de fond : on laisse d'abord l'écran d'accueil se poser. */
const AUTO_CHECK_DELAY_MS = 6000;

/** Lit la version installée, vérifie en silence s'il existe une release plus récente, et affiche la notification. */
function UpdaterBootstrap() {
  useEffect(() => {
    const { init, checkForUpdates } = useUpdaterStore.getState();
    void init();
    const timer = window.setTimeout(
      () => void checkForUpdates({ silent: true }),
      AUTO_CHECK_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);
  return <UpdateToast />;
}

/**
 * Racine réelle de l'application : sans `BootstrapGate`, le lancement
 * n'ouvrirait jamais le dernier vault et afficherait toujours l'écran de choix,
 * contrairement à SPEC §6. L'`ErrorBoundary` évite aussi une fenêtre blanche.
 */
export function App() {
  return (
    <Providers>
      <BootstrapGate>
        <AppearanceSync />
        <RouterProvider router={router} />
        <UpdaterBootstrap />
      </BootstrapGate>
    </Providers>
  );
}
