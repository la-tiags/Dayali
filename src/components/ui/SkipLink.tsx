import type { MouseEvent, ReactNode } from "react";

export interface SkipLinkProps {
  readonly targetId?: string;
  readonly children?: ReactNode;
}

/**
 * Lien d'évitement compatible avec le `HashRouter` : un `href="#contenu"` brut
 * serait interprété comme une route (`/contenu`). On garde un vrai lien pour
 * les technologies d'assistance, mais on déplace le focus sans toucher à l'URL.
 */
export function SkipLink({ targetId = "contenu", children = "Aller au contenu" }: SkipLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Un `href="#contenu"` serait interprété comme la route `/contenu` par le
    // HashRouter : on neutralise toujours la navigation (y compris avec
    // modificateur), puis on déplace le focus nous-mêmes.
    if (event.defaultPrevented || event.button !== 0) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.({ block: "start" });
  };

  return (
    <a className="skip-link" href={`#${targetId}`} onClick={handleClick}>
      {children}
    </a>
  );
}
