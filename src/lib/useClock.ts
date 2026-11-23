import { useEffect, useState } from "react";

/**
 * Horloge de l'UI. L'instant est réinjecté dans les composants (`now`) pour que
 * les écrans restent testables sans horloge réelle (PLAN §7.3).
 */
export function useClock(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, intervalMs);
    // Une machine en veille ne fait pas tourner les minuteurs : au retour de la fenêtre, l'heure
    // est relue tout de suite, pour que la journée logique ne reste pas celle de la veille.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", tick);
    };
  }, [intervalMs]);
  return now;
}
