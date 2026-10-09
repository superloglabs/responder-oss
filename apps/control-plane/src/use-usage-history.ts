import { useEffect, useState } from "react";
import type { UsageHistory, UsageHistoryDays } from "./usage-history-presentation";

// Loads usage for the chosen range. A range change keeps showing the last
// result until the new one arrives; `loadedDays` is the range it covers.
export function useUsageHistory(
  load: (days: UsageHistoryDays) => Promise<UsageHistory>,
  days: UsageHistoryDays,
): { error: string | null; history: UsageHistory | null; loadedDays: UsageHistoryDays | null; loading: boolean } {
  const [state, setState] = useState<{
    days: UsageHistoryDays | null;
    error: string | null;
    history: UsageHistory | null;
    loadedDays: UsageHistoryDays | null;
  }>({ days: null, error: null, history: null, loadedDays: null });
  useEffect(() => {
    let active = true;
    void load(days).then(
      (history) => { if (active) setState({ days, error: null, history, loadedDays: days }); },
      (cause: unknown) => {
        if (active) setState((current) => ({ ...current, days, error: cause instanceof Error ? cause.message : "Unable to load usage" }));
      },
    );
    return () => { active = false; };
  }, [days, load]);
  return {
    error: state.error,
    history: state.history,
    loadedDays: state.loadedDays,
    loading: state.days !== days,
  };
}
