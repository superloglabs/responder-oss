import { useCallback, useEffect, useRef, useState } from "react";

// How often a live explorer reloads.
const liveIntervalMs = 10_000;

export interface TelemetryQueryState<T> {
  data: T | null;
  error: string | null;
  isFetching: boolean;
  retry: () => void;
}

// Loads `load` again whenever `key` changes, and every few seconds while
// `live`. A new key clears old data unless keepPreviousData is enabled.
// Keeping prior results avoids tearing down an explorer during a refetch;
// isFetching distinguishes those results from the newly requested ones.
export function useTelemetryQuery<T>(
  key: string | null,
  load: () => Promise<T>,
  live = false,
  keepPreviousData = false,
): TelemetryQueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(async (clear: boolean) => {
    if (key === null) return;
    const generation = ++request.current;
    setPending(true);
    if (clear && !keepPreviousData) setData(null);
    try {
      const loaded = await loadRef.current();
      if (request.current !== generation) return;
      setData(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      if (clear && !keepPreviousData) setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load telemetry");
    } finally {
      if (request.current === generation) {
        setSettledKey(key);
        setPending(false);
      }
    }
  }, [key, keepPreviousData]);

  useEffect(() => {
    void Promise.resolve().then(() => run(true));
    return () => { request.current += 1; };
  }, [run]);

  useEffect(() => {
    if (!live || key === null) return;
    const timer = window.setInterval(() => void run(false), liveIntervalMs);
    return () => window.clearInterval(timer);
  }, [key, live, run]);

  return { data, error, isFetching: key !== null && (pending || settledKey !== key), retry: () => void run(true) };
}
