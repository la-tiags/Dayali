import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  message: string | null;
}

/**
 * Filet de dernier recours : une exception de rendu ne doit pas laisser une
 * fenêtre blanche. Aucun détail technique n'est exposé au-delà du message.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : "Erreur inattendue." };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Les logs applicatifs sont gérés côté Rust ; on ne journalise pas de
    // contenu utilisateur ici, et jamais de secret.
    console.error("Dayali — erreur de rendu", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message) {
      return (
        <div role="alert" style={{ padding: "2rem", maxWidth: "48rem", margin: "0 auto" }}>
          <h1>Dayali a rencontré une erreur.</h1>
          <p>{this.state.message}</p>
          <p>Vos fichiers n'ont pas été modifiés par cette erreur.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Recharger l'application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}
