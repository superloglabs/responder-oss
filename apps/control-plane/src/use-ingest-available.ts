import { useEffect, useState } from "react";
import { fetchIngestKeys } from "./ingest-keys-api";

// Whether this workspace can send telemetry to this cell, once known.
export function useIngestAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchIngestKeys()
      .then((keys) => { if (!cancelled) setAvailable(keys !== null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return available;
}
