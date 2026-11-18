import { useEffect, useState } from "react";

/**
 * Horloge de l'UI. L'instant est réinjecté dans les composants (`now`) pour que
 * les écrans restent testables sans horloge réelle (PLAN §7.3).
 */
export function useClock(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
