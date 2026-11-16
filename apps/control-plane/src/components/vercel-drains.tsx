import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconX } from "@tabler/icons-react";
import { Button } from "../design-system";
import {
  connectVercelSource,
  fetchTelemetrySources,
  removeTelemetrySource,
  sourceHealth,
  type TelemetrySourceSummary,
} from "../telemetry-sources-api";
// The drain chip reuses the AWS region chips.
import "./aws-log-streaming.css";

// The drains that send one Vercel connection's traces and logs to Superlog:
// the value of the connection's "Telemetry from" row. Errors in them become
// error issues, which alert people and start Signal. Where this workspace or
// cell cannot receive telemetry, `available` is false.
export interface VercelDrainsParts {
  available: boolean;
  row: ReactNode;
}

export function VercelDrains({ integrationAccountId, children }: {
  children: (parts: VercelDrainsParts) => ReactNode;
  integrationAccountId: string;
}) {
  // Undefined while loading; null when telemetry is not available here.
  const [source, setSource] = useState<TelemetrySourceSummary | null | undefined>(undefined);
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const overview = await fetchTelemetrySources();
    setAvailable(overview !== null);
    setSource(overview?.sources.find((item) => item.provider === "vercel" && item.integrationAccountId === integrationAccountId) ?? null);
    setLoadError("");
  }, [integrationAccountId]);

  useEffect(() => {
    let current = true;
    fetchTelemetrySources()
      .then((overview) => {
        if (!current) return;
        setAvailable(overview !== null);
        setSource(overview?.sources.find((item) => item.provider === "vercel" && item.integrationAccountId === integrationAccountId) ?? null);
      })
      .catch((failure: unknown) => { if (current) setLoadError(failure instanceof Error ? failure.message : "Could not load the Vercel drains."); });
    return () => { current = false; };
  }, [integrationAccountId]);

  // New drains show "Waiting for data" until Vercel's first delivery; the row
  // refreshes until then.
  const waiting = Boolean(source && !source.lastReceivedAt);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => void load().catch(() => undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [load, waiting, source]);

  if (loadError) {
    return <>{children({ available: true, row: <p className="awsLogStreaming__error" role="alert">{loadError}</p> })}</>;
  }
  if (!available) return <>{children({ available: false, row: null })}</>;
  if (source === undefined) return <>{children({ available: true, row: <p className="awsLogStreaming__none" role="status">Loading…</p> })}</>;

  async function change(action: () => Promise<unknown>) {
    setSaving(true);
    setError("");
    try {
      await action();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const health = source ? sourceHealth(source) : null;
  return <>{children({
    available: true,
    row: <div className="awsLogStreaming__regions">
      <ul aria-label="Vercel drains that send telemetry to Superlog">
        {source && health
          ? <li className="awsRegionChip" title={source.lastError ?? undefined}>
            <span>Traces and logs</span>
            <span className={`awsRegionChip__status awsRegionChip__status--${health.tone}`}>{health.label}</span>
            <button
              aria-label="Remove the Vercel drains"
              className="awsRegionChip__remove"
              disabled={saving}
              onClick={() => void change(() => removeTelemetrySource(source.id))}
              type="button">
              <IconX aria-hidden="true" size={12} stroke={2} />
            </button>
          </li>
          : <li className="awsLogStreaming__item">
            <Button loading={saving} onClick={() => void change(() => connectVercelSource(integrationAccountId))} size="small">
              Create drains
            </Button>
          </li>}
      </ul>
      {source?.status === "failed" && source.lastError && <p className="awsLogStreaming__error">{source.lastError}</p>}
      {error && <p className="awsLogStreaming__error" role="alert">{error}</p>}
    </div>,
  })}</>;
}
