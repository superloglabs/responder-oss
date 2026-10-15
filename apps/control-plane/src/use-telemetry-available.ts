import { useEffect, useState } from "react";
import { fetchTelemetryAvailable } from "./telemetry-api";

export type TelemetryAvailableState = ReturnType<typeof useTelemetryAvailable>;

// Undefined while loading; false when the workspace cannot read telemetry.
export function useTelemetryAvailable() {
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTelemetryAvailable()
      .then((loaded) => {
        if (cancelled) return;
        setAvailable(loaded);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to check telemetry");
        }
      });
    return () => { cancelled = true; };
  }, [attempt]);

  return {
    available,
    error,
    retry: () => {
      setError(null);
      setAttempt((current) => current + 1);
    },
  };
}
