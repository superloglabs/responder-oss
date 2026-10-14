import { apiErrorMessage } from "./agents-api";
import type { TelemetryIngestKeySummary } from "../../../packages/core/src/db/telemetry-ingest-keys";

export type { TelemetryIngestKeySummary };

const base = "/api/telemetry/ingest-keys";

// Null when this workspace or cell cannot receive telemetry.
export async function fetchIngestKeys(): Promise<TelemetryIngestKeySummary[] | null> {
  const response = await fetch(base);
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as { keys: TelemetryIngestKeySummary[] } | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body?.keys ?? [];
}

export async function createIngestKey(input: { name: string; projectId?: string }): Promise<{
  key: TelemetryIngestKeySummary;
  token: string;
}> {
  const response = await fetch(base, {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as { key: TelemetryIngestKeySummary; token: string } | null;
  if (!response.ok || !body) throw new Error(apiErrorMessage(body, response.status));
  return body;
}

export async function revokeIngestKey(keyId: string): Promise<void> {
  const response = await fetch(`${base}/${encodeURIComponent(keyId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(apiErrorMessage(await response.json().catch(() => null), response.status));
}

// OpenTelemetry SDK settings for a key. The SDK adds /v1/logs, /v1/traces
// and /v1/metrics to the endpoint.
export function otlpEnvironment(origin: string, token: string): string {
  return [
    `OTEL_EXPORTER_OTLP_ENDPOINT=${origin.replace(/\/+$/u, "")}/api/ingest`,
    "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    `OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${token}`,
  ].join("\n");
}
