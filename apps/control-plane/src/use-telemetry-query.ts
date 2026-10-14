import { useCallback, useEffect, useRef, useState } from "react";

// How often a live explorer reloads.
const liveIntervalMs = 10_000;

export interface TelemetryQueryState<T> {
  data: T | null;
  error: string | null;
  retry: () => void;
}

// Loads `load` again whenever `key` changes, and every few seconds while
// `live`. A new key clears the old data; a live reload keeps it on screen
// until the new data arrives.
export function useTelemetryQuery<T>(
  key: string | null,
  load: () => Promise<T>,
  live = false,
): TelemetryQueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(async (clear: boolean) => {
    if (key === null) return;
    const generation = ++request.current;
    if (clear) setData(null);
    try {
      const loaded = await loadRef.current();
      if (request.current !== generation) return;
      setData(loaded);
      setError(null);
    } catch (cause) {
      if (request.current !== generation) return;
      if (clear) setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load telemetry");
    }
  }, [key]);

  useEffect(() => {
    void Promise.resolve().then(() => run(true));
    return () => { request.current += 1; };
  }, [run]);

  useEffect(() => {
    if (!live || key === null) return;
    const timer = window.setInterval(() => void run(false), liveIntervalMs);
    return () => window.clearInterval(timer);
  }, [key, live, run]);

  return { data, error, retry: () => void run(true) };
}
