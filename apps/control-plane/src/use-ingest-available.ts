import { useEffect, useState } from "react";
import { fetchIngestKeys } from "./ingest-keys-api";

// Whether this workspace can send telemetry to this cell, once known. A
// failed check is tried again a few times before the link stays hidden.
export function useIngestAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (attempt: number) => {
      fetchIngestKeys()
        .then((keys) => { if (!cancelled) setAvailable(keys !== null); })
        .catch(() => {
          if (!cancelled && attempt < 3) timer = setTimeout(() => check(attempt + 1), 2_000 * 2 ** attempt);
        });
    };
    check(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return available;
}
