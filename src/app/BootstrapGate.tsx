import { type ReactNode, useEffect } from "react";
import { useAppStore } from "../stores/app.store";

function Splash({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        minHeight: "100%",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        color: "var(--color-text-muted)",
      }}
    >
      <p style={{ fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase" }}>Dayali</p>
      <p>{label}</p>
    </div>
  );
}

/**
 * Exécute `bootstrap()` une seule fois (lecture de `machine.json` hors vault,
 * réouverture du dernier vault) puis rend l'application. En cas d'échec de
 * réouverture, l'écran de choix affiche l'erreur et la liste des récents.
 */
export function BootstrapGate({ children }: { children: ReactNode }) {
  const status = useAppStore((state) => state.status);
  const bootstrap = useAppStore((state) => state.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status !== "ready") {
    return <Splash label={status === "loading" ? "Ouverture du vault…" : "Chargement…"} />;
  }
  return <>{children}</>;
}
