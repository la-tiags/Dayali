import { RouterProvider } from "react-router";
import { BootstrapGate } from "@/app/BootstrapGate";
import { Providers } from "@/app/providers";
import { router } from "@/app/router";

/**
 * Racine réelle de l'application : sans `BootstrapGate`, le lancement
 * n'ouvrirait jamais le dernier vault et afficherait toujours l'écran de choix,
 * contrairement à SPEC §6. L'`ErrorBoundary` évite aussi une fenêtre blanche.
 */
export function App() {
  return (
    <Providers>
      <BootstrapGate>
        <RouterProvider router={router} />
      </BootstrapGate>
    </Providers>
  );
}
