import { useEffect, useState } from "react";

export interface DayState {
  started: boolean;
  lastDayStartedAt: string | null;
  lateNightShownFor: string | null;
  carryOverCandidates: unknown[];
}

export function useDayState(): [DayState | null, (s: DayState) => void] {
  const [state, setState] = useState<DayState | null>(null);
  useEffect(() => {
    // Mock fallback: vault-sync IPC will replace this.
    setState({
      started: false,
      lastDayStartedAt: null,
      lateNightShownFor: null,
      carryOverCandidates: [],
    });
  }, []);
  return [state, setState];
}
